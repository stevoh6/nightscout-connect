'use strict';

/**
 * Based on:
 * https://github.com/jonfawcett/glooko2nightscout-bridge/blob/master/index.js#L146
 *
 * This file in your branch was previously a single-line WIP port. This version:
 * - adds redact-safe structured logging
 * - adds retries/backoff
 * - fixes URL construction bugs
 * - adds runStandalone() so you can test outside the app
 */

const url = require('url');
const helper = require('./convert');
const { createLogger } = require('./logger');

/** @type {Record<string, string>} */
const _known_servers = {
  default: 'api.glooko.com',
  development: 'api.glooko.work',
  production: 'externalapi.glooko.com',
  eu: 'eu.api.glooko.com',
};

const Defaults = {
  applicationId: 'd89443d2-327c-4a6f-89e5-496bbb0317db',
  lastGuid: '1e0c094e-1e54-4a4f-8e6a-f94484b53789',

  login: '/api/v2/users/sign_in',
  mime: 'application/json',

  LatestFoods: '/api/v2/foods',
  LatestInsulins: '/api/v2/insulins',
  LatestPumpBasals: '/api/v2/pumps/scheduled_basals',
  LatestPumpBolus: '/api/v2/pumps/normal_boluses',
  LatestCGMReadings: '/api/v2/cgm/readings',
  PumpSettings: '/api/v2/pumps/settings',
};

/**
 * @param {object} spec
 * @param {string} [spec.glookoServer]
 * @param {string} [spec.glookoEnv]
 * @returns {string}
 */
function base_for(spec) {
  const server = spec.glookoServer ? spec.glookoServer : _known_servers[spec.glookoEnv || 'default'];
  return url.format({ protocol: 'https', host: server });
}

/**
 * @param {object} opts
 * @param {string} opts.glookoEmail
 * @param {string} opts.glookoPassword
 * @returns {object}
 */
function login_payload(opts) {
  return {
    userLogin: {
      email: opts.glookoEmail,
      password: opts.glookoPassword,
    },
    deviceInformation: {
      applicationType: 'logbook',
      os: 'android',
      osVersion: '33',
      device: 'Google Pixel 8 Pro',
      deviceManufacturer: 'Google',
      deviceModel: 'Pixel 8 Pro',
      serialNumber: 'HIDDEN',
      clinicalResearch: false,
      deviceId: 'HIDDEN',
      applicationVersion: '6.1.3',
      buildNumber: '0',
      gitHash: 'g4fbed2011b',
    },
  };
}

/**
 * Simple sleep helper.
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry wrapper (exponential backoff).
 * @param {() => Promise<any>} fn
 * @param {{logger: any, label: string, maxRetries: number, baseDelayMs: number}} cfg
 */
async function withRetries(fn, cfg) {
  const { logger, label, maxRetries, baseDelayMs } = cfg;

  let attempt = 0;
  // attempt=0 is first try, attempt=1..maxRetries are retries
  // total tries = maxRetries + 1
  // delay = baseDelayMs * 2^(attempt-1) for retries
  while (true) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxRetries) {
        logger.error(`${label}:failed`, {
          attempt,
          maxRetries,
          message: err?.message,
          status: err?.response?.status,
        });
        throw err;
      }

      const delay = Math.round(baseDelayMs * Math.pow(2, Math.max(0, attempt)));
      logger.warn(`${label}:retry`, {
        attempt,
        nextAttempt: attempt + 1,
        maxRetries,
        delayMs: delay,
        message: err?.message,
        status: err?.response?.status,
      });

      await sleep(delay);
      attempt++;
    }
  }
}

/**
 * Builds a URL like:
 *   /api/v2/foods?patient=CODE&startDate=...&endDate=...
 */
function constructUrl(endpoint, patientCode, startDate, endDate) {
  // Ensure Dates
  const s = startDate instanceof Date ? startDate : new Date(startDate);
  const e = endDate instanceof Date ? endDate : new Date(endDate);

  return (
    endpoint +
    '?patient=' +
    encodeURIComponent(patientCode) +
    '&startDate=' +
    encodeURIComponent(s.toISOString()) +
    '&endDate=' +
    encodeURIComponent(e.toISOString())
  );
}

/**
 * Extract useful pagination info from response headers (if present).
 * Glooko docs mention pageNumber/page size for some endpoints. This is generic.
 */
function parsePaginationFromHeaders(headers = {}) {
  const h = {};
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v;

  // Common patterns (best-effort)
  const page = Number(h['x-page-number'] ?? h['page-number'] ?? h['x-page'] ?? NaN);
  const totalPages = Number(h['x-total-pages'] ?? h['total-pages'] ?? NaN);
  const totalCount = Number(h['x-total-count'] ?? h['total-count'] ?? NaN);
  const pageSize = Number(h['x-page-size'] ?? h['page-size'] ?? NaN);

  return {
    pageNumber: Number.isFinite(page) ? page : undefined,
    totalPages: Number.isFinite(totalPages) ? totalPages : undefined,
    totalCount: Number.isFinite(totalCount) ? totalCount : undefined,
    pageSize: Number.isFinite(pageSize) ? pageSize : undefined,
  };
}

/**
 * @param {object} opts
 * @param {string} opts.baseURL
 * @param {string} [opts.glookoServer]
 * @param {string} [opts.glookoEnv]
 * @param {string} opts.glookoEmail
 * @param {string} opts.glookoPassword
 * @param {number} [opts.glookoTimezoneOffset]  (ms)
 * @param {number} [opts.glookoMaxRetries]
 * @param {number} [opts.glookoRetryDelayMs]
 * @param {import('axios').AxiosStatic} axios
 * @returns {object}
 */
function glookoSource(opts, axios) {
  const logger = opts.logger || createLogger({ name: 'glooko', level: process.env.GLOOKO_LOG_LEVEL || 'info' });

  const baseURL = opts.baseURL;
  const referrer = 'https://eu.my.glooko.com';

  const default_headers = {
    Accept: 'application/json, text/plain, */*',
    'Accept-Encoding': 'gzip, deflate, br',
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Safari/605.1.15',
    Referer: `${referrer}/`,
    Origin: `${referrer}`,
    Connection: 'keep-alive',
    'Accept-Language': 'en-GB,en;q=0.9',
  };

  const http = axios.create({ baseURL, headers: default_headers });

  // Allow configuring retry behavior
  const maxRetries = Number.isFinite(opts.glookoMaxRetries) ? opts.glookoMaxRetries : Number(process.env.GLOOKO_MAX_RETRIES || 2);
  const retryDelayMs = Number.isFinite(opts.glookoRetryDelayMs)
    ? opts.glookoRetryDelayMs
    : Number(process.env.GLOOKO_RETRY_DELAY_MS || 800);

  async function httpGet(path, { headers, params } = {}) {
    const t = logger.time('http:get', { path, params });
    const res = await withRetries(
      async () => {
        return await http.get(path, { headers, params });
      },
      { logger, label: 'http:get', maxRetries, baseDelayMs: retryDelayMs }
    );
    t.end({ status: res.status, pagination: parsePaginationFromHeaders(res.headers) });
    return res;
  }

  async function httpPost(path, data, { headers, params } = {}) {
    const t = logger.time('http:post', { path, params });
    const res = await withRetries(
      async () => {
        return await http.post(path, data, { headers, params });
      },
      { logger, label: 'http:post', maxRetries, baseDelayMs: retryDelayMs }
    );
    t.end({ status: res.status, pagination: parsePaginationFromHeaders(res.headers) });
    return res;
  }

  const impl = {
    async authFromCredentials() {
      const payload = login_payload(opts);

      logger.info('auth:start', {
        baseURL,
        glookoEnv: opts.glookoEnv,
        glookoServer: opts.glookoServer,
        emailPresent: Boolean(opts.glookoEmail),
        passwordPresent: Boolean(opts.glookoPassword),
      });

      const response = await httpPost(Defaults.login, payload);

      const setCookie = Array.isArray(response.headers?.['set-cookie']) ? response.headers['set-cookie'] : [];
      const cookie0 = setCookie[0];

      // IMPORTANT: do NOT log cookies or full response.data
      logger.info('auth:ok', {
        status: response.status,
        setCookieCount: setCookie.length,
        hasCookie0: Boolean(cookie0),
        userKeys: response.data ? Object.keys(response.data) : [],
      });

      return {
        cookies: cookie0,
        user: response.data,
      };
    },

    /**
     * @param {{cookies: string, user: any}} auth
     * @returns {Promise<{cookies: string, user: any}>}
     */
    sessionFromAuth(auth) {
      return Promise.resolve(auth);
    },

    /**
     * Fetch raw batches from Glooko.
     * @param {{cookies: string, user: any}} session
     * @param {{entries: Date}} last_known
     */
    async dataFromSesssion(session, last_known) {
      const twoDaysAgoMs = Date.now() - 2 * 24 * 60 * 60 * 1000;
      const lastMs = Math.max(twoDaysAgoMs, last_known?.entries ? last_known.entries.getTime() : twoDaysAgoMs);

      // 5 min granularity; keep as your original intent
      const maxCount = Math.ceil((Date.now() - lastMs) / (1000 * 60 * 5));
      const lastUpdatedAt = new Date(twoDaysAgoMs);

      const params = {
        lastGuid: Defaults.lastGuid,
        lastUpdatedAt,
        limit: maxCount,
      };

      const patientCode = session?.user?.userLogin?.glookoCode;
      if (!patientCode) {
        logger.error('session:missing_patient_code', {
          userKeys: session?.user ? Object.keys(session.user) : [],
          userLoginKeys: session?.user?.userLogin ? Object.keys(session.user.userLogin) : [],
        });
        throw new Error('Missing session.user.userLogin.glookoCode');
      }

      const headers = {
        ...default_headers,
        Cookie: session.cookies,
      };

      // Host header is optional; set only if provided
      if (opts.glookoServer) headers.Host = opts.glookoServer;

      headers['Sec-Fetch-Dest'] = 'empty';
      headers['Sec-Fetch-Mode'] = 'cors';
      headers['Sec-Fetch-Site'] = 'same-site';

      const endDate = new Date();
      const startDate = new Date(twoDaysAgoMs);

      const includeCgm = process.env.CONNECT_GLOOKO_INCLUDE_CGM === '1';
      
      const endpoints = [
        Defaults.LatestFoods,
        Defaults.LatestInsulins,
        Defaults.LatestPumpBasals,
        Defaults.LatestPumpBolus,
      ];
      
      if (includeCgm) endpoints.push(Defaults.LatestCGMReadings);
      
      const urlsToFetch = endpoints.map((endpoint) => constructUrl(endpoint, patientCode, startDate, endDate));

      logger.info('fetch:start', {
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
        endpoints: urlsToFetch.map((u) => u.split('?')[0]),
        maxCount,
      });

      const results = [];
      for (const reqUrl of urlsToFetch) {
        logger.debug('fetch:item', { urlPath: reqUrl.split('?')[0] });

        const resp = await httpGet(reqUrl, { headers, params });
        results.push(resp.data);

        // Tiny per-endpoint summary (safe)
        logger.info('fetch:ok', {
          urlPath: reqUrl.split('?')[0],
          dataKeys: resp.data ? Object.keys(resp.data) : [],
        });
      }

      // Your old code expects .foods .insulins etc
      const batch = {
        foods: results[0]?.foods,
        insulins: results[1]?.insulins,
        scheduledBasals: results[2]?.scheduledBasals,
        normalBoluses: results[3]?.normalBoluses,
        readings: results[4]?.readings,
      };

      logger.info('fetch:summary', {
        foods: Array.isArray(batch.foods) ? batch.foods.length : 0,
        insulins: Array.isArray(batch.insulins) ? batch.insulins.length : 0,
        scheduledBasals: Array.isArray(batch.scheduledBasals) ? batch.scheduledBasals.length : 0,
        normalBoluses: Array.isArray(batch.normalBoluses) ? batch.normalBoluses.length : 0,
        readings: Array.isArray(batch.readings) ? batch.readings.length : 0,
      });

      return batch;
    },

    align_to_glucose() {
      // TODO
    },

    /**
     * @param {object} batch
     * @returns {{entries: any[], treatments: any[]}}
     */
    transformData(batch) {
      logger.info('transform:start', {
        foods: Array.isArray(batch?.foods) ? batch.foods.length : 0,
        insulins: Array.isArray(batch?.insulins) ? batch.insulins.length : 0,
        pumpBoluses: Array.isArray(batch?.normalBoluses) ? batch.normalBoluses.length : 0,
        scheduledBasals: Array.isArray(batch?.scheduledBasals) ? batch.scheduledBasals.length : 0,
      });

      const treatments = helper.generate_nightscout_treatments(batch, opts.glookoTimezoneOffset, logger);

      logger.info('transform:done', { treatments: Array.isArray(treatments) ? treatments.length : 0 });

      return { entries: [], treatments };
    },
  };

  function tracker_for() {
    const AxiosTracer = require('../../trace-axios');
    return AxiosTracer(http);
  }

  function generate_driver(builder) {
      const logger = opts.logger || createLogger({ name: 'glooko' });

  if (process.env.CONNECT_GLOOKO_MANUAL_ONLY === '1') {
    logger.warn('loop:disabled_manual_only', { env: 'CONNECT_GLOOKO_MANUAL_ONLY=1' });

    // still register session/auth support (so you can reuse it),
    // but skip the periodic loop.
    builder.support_session({
      authenticate: impl.authFromCredentials,
      authorize: impl.sessionFromAuth,
      delays: {
        REFRESH_AFTER_SESSSION_DELAY: 1000 * 60 * 60 * 24 * 1 - 600000,
        EXPIRE_SESSION_DELAY: 1000 * 60 * 60 * 24 * 1,
      },
    });

    return builder;
  }
    
    builder.support_session({
      authenticate: impl.authFromCredentials,
      authorize: impl.sessionFromAuth,
      delays: {
        REFRESH_AFTER_SESSSION_DELAY: 1000 * 60 * 60 * 24 * 1 - 600000,
        EXPIRE_SESSION_DELAY: 1000 * 60 * 60 * 24 * 1,
      },
    });

    builder.register_loop('Glooko', {
      tracker: tracker_for,
      frame: {
        impl: impl.dataFromSesssion,
        align_schedule: impl.align_to_glucose,
        transform: impl.transformData,

        // retries are handled inside http wrapper; keep these conservative
        backoff: { interval_ms: 2.5 * 60 * 1000 },
        maxRetries: 1,
      },

      expected_data_interval_ms: 5 * 60 * 1000,
      backoff: { interval_ms: 2.5 * 60 * 1000 },
    });

    return builder;
  }

  impl.generate_driver = generate_driver;

  /**
   * Standalone runner: logs in, fetches batch, transforms, returns {batch, entries, treatments}
   * so you can test outside the app.
   */
  impl.runStandalone = async function runStandalone({ lastKnownEntriesDate } = {}) {
    const last_known = lastKnownEntriesDate ? { entries: new Date(lastKnownEntriesDate) } : { entries: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) };

    logger.info('standalone:start', { lastKnownEntriesDate: last_known.entries.toISOString() });

    const auth = await impl.authFromCredentials();
    const session = await impl.sessionFromAuth(auth);
    const batch = await impl.dataFromSesssion(session, last_known);
    const transformed = impl.transformData(batch);

    logger.info('standalone:done', {
      treatments: Array.isArray(transformed?.treatments) ? transformed.treatments.length : 0,
    });

    return { batch, ...transformed };
  };

  return impl;
}

/**
 * @param {object} input
 * @param {string} [input.glookoEnv]
 * @param {string} [input.glookoServer]
 * @param {string} input.glookoEmail
 * @param {string} input.glookoPassword
 * @param {number} [input.glookoTimezoneOffset] (hours)
 * @returns {{ok: boolean, errors: {desc: string, err: Error}[], config: object}}
 */
glookoSource.validate = function validate_inputs(input) {
  const baseURL = base_for(input);
  const offsetMs = !isNaN(input.glookoTimezoneOffset) ? input.glookoTimezoneOffset * -60 * 60 * 1000 : 0;

  const config = {
    glookoEnv: input.glookoEnv,
    glookoServer: input.glookoServer,
    glookoEmail: input.glookoEmail,
    glookoPassword: input.glookoPassword,
    glookoTimezoneOffset: offsetMs,
    baseURL,
  };

  const errors = [];
  if (!config.glookoEmail) {
    errors.push({
      desc: 'The Glooko User Login Email is required. CONNECT_GLOOKO_EMAIL must be an email belonging to an active Glooko User to log in.',
      err: new Error('CONNECT_GLOOKO_EMAIL'),
    });
  }
  if (!config.glookoPassword) {
    errors.push({
      desc: 'Glooko User Login Password is required. CONNECT_GLOOKO_PASSWORD must be the password for the Glooko User Login.',
      err: new Error('CONNECT_GLOOKO_PASSWORD'),
    });
  }

  const ok = errors.length === 0;
  config.kind = ok ? 'glooko' : 'disabled';
  return { ok, errors, config };
};

/**
 * Convenience: standalone entrypoint without touching Nightscout internals.
 * Usage: require('./glooko').runStandalone(config, axios)
 */
glookoSource.runStandalone = async function runStandalone(config, axios) {
  const logger = config.logger || createLogger({ name: 'glooko-standalone', level: process.env.GLOOKO_LOG_LEVEL || 'debug' });
  const impl = glookoSource({ ...config, logger }, axios);
  return impl.runStandalone({ lastKnownEntriesDate: config.lastKnownEntriesDate });
};

module.exports = glookoSource;
