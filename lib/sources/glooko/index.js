'use strict';

/**
 * Glooko source.
 *
 * Changes in this version:
 * - Structured redact-safe logging
 * - Retry/backoff for HTTP calls
 * - Manual mode: CONNECT_GLOOKO_MANUAL_ONLY=1 disables the periodic loop
 * - USB-sync aware: fetch PumpSettings first and only fetch data when lastUpdatedAt changes
 * - Persist lastSeenUploadAt to a small state file (default /data/glooko-state.json)
 * - Backfill window when upload changes (overlap hours configurable)
 * - Do NOT throttle by "limit=maxCount" tied to CGM entries (fixes "1 basal + 1 bolus forever")
 */

const url = require('url');
const fs = require('fs');
const path = require('path');

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
  lastGuid: '1e0c094e-1e54-4a6f-89e5-496bbb0317db'.slice(0, 36), // not relied on anymore; keep placeholder style

  login: '/api/v2/users/sign_in',
  mime: 'application/json',

  LatestFoods: '/api/v2/foods',
  LatestInsulins: '/api/v2/insulins',
  LatestPumpBasals: '/api/v2/pumps/scheduled_basals',
  LatestPumpBolus: '/api/v2/pumps/normal_boluses',
  LatestCGMReadings: '/api/v2/cgm/readings',
  PumpSettings: '/api/v2/pumps/settings',
};

function base_for(spec) {
  const server = spec.glookoServer ? spec.glookoServer : _known_servers[spec.glookoEnv || 'default'];
  return url.format({ protocol: 'https', host: server });
}

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetries(fn, cfg) {
  const { logger, label, maxRetries, baseDelayMs } = cfg;

  let attempt = 0;
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

function constructUrl(endpoint, patientCode, startDate, endDate) {
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

function parsePaginationFromHeaders(headers = {}) {
  const h = {};
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v;

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

function loadState(statePath, logger) {
  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    logger?.debug?.('state:load:empty', { statePath });
    return {};
  }
}

function saveState(statePath, state, logger) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  logger?.info?.('state:saved', { statePath, keys: Object.keys(state || {}) });
}

/**
 * Tries to extract the Glooko "last upload" timestamp from PumpSettings response.
 * We don't know the exact schema in every region, so we check multiple candidates.
 */
function extractLastUpdatedAt(settingsData) {
  const candidates = [
    settingsData?.lastUpdatedAt,
    settingsData?.pumpSettings?.lastUpdatedAt,
    settingsData?.settings?.lastUpdatedAt,
    settingsData?.pump?.lastUpdatedAt,
    settingsData?.data?.lastUpdatedAt,
  ].filter(Boolean);

  return candidates.length ? candidates[0] : null;
}

/**
 * @param {object} opts
 * @param {string} opts.baseURL
 * @param {string} [opts.glookoServer]
 * @param {string} [opts.glookoEnv]
 * @param {string} opts.glookoEmail
 * @param {string} opts.glookoPassword
 * @param {number} [opts.glookoTimezoneOffset] (ms)
 * @param {string} [opts.glookoStartDate] ISO
 * @param {string} [opts.glookoEndDate] ISO
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

  const maxRetries = Number.isFinite(opts.glookoMaxRetries) ? opts.glookoMaxRetries : Number(process.env.GLOOKO_MAX_RETRIES || 2);
  const retryDelayMs = Number.isFinite(opts.glookoRetryDelayMs)
    ? opts.glookoRetryDelayMs
    : Number(process.env.GLOOKO_RETRY_DELAY_MS || 800);

  const statePath = process.env.GLOOKO_STATE_PATH || '/data/glooko-state.json';
  const overlapHours = Number(process.env.GLOOKO_USB_OVERLAP_HOURS || 48);

  async function httpGet(path_, { headers, params } = {}) {
    const t = logger.time('http:get', { path: path_, params });
    const res = await withRetries(
      async () => {
        return await http.get(path_, { headers, params });
      },
      { logger, label: 'http:get', maxRetries, baseDelayMs: retryDelayMs }
    );
    t.end({ status: res.status, pagination: parsePaginationFromHeaders(res.headers) });
    return res;
  }

  async function httpPost(path_, data, { headers, params } = {}) {
    const t = logger.time('http:post', { path: path_, params });
    const res = await withRetries(
      async () => {
        return await http.post(path_, data, { headers, params });
      },
      { logger, label: 'http:post', maxRetries, baseDelayMs: retryDelayMs }
    );
    t.end({ status: res.status, pagination: parsePaginationFromHeaders(res.headers) });
    return res;
  }

  function buildAuthHeaders(session) {
    const headers = {
      ...default_headers,
      Cookie: session.cookies,
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-site',
    };
    if (opts.glookoServer) headers.Host = opts.glookoServer;
    return headers;
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

      logger.info('auth:ok', {
        status: response.status,
        setCookieCount: setCookie.length,
        hasCookie0: Boolean(cookie0),
        userKeys: response.data ? Object.keys(response.data) : [],
      });

      return { cookies: cookie0, user: response.data };
    },

    sessionFromAuth(auth) {
      return Promise.resolve(auth);
    },

    /**
     * Fetch batch from Glooko. USB-sync aware:
     * - fetch PumpSettings first
     * - compare lastUpdatedAt against persisted watermark
     * - if unchanged and not forced -> skip
     */
    async dataFromSesssion(session, last_known) {
      const headers = buildAuthHeaders(session);

      const patientCode = session?.user?.userLogin?.glookoCode;
      if (!patientCode) {
        logger.error('session:missing_patient_code', {
          userKeys: session?.user ? Object.keys(session.user) : [],
          userLoginKeys: session?.user?.userLogin ? Object.keys(session.user.userLogin) : [],
        });
        throw new Error('Missing session.user.userLogin.glookoCode');
      }

      const forceFetch = process.env.CONNECT_GLOOKO_FORCE_FETCH === '1';

      // 1) read PumpSettings to detect new USB upload
      let settingsData = null;
      let uploadAt = null;

      try {
        const settingsResp = await httpGet(Defaults.PumpSettings, { headers });
        settingsData = settingsResp.data;
        uploadAt = extractLastUpdatedAt(settingsData);

        logger.info('settings:ok', {
          keys: settingsData ? Object.keys(settingsData) : [],
          hasLastUpdatedAt: Boolean(uploadAt),
          lastUpdatedAt: uploadAt || null,
        });
      } catch (e) {
        logger.warn('settings:failed', { message: e?.message, status: e?.response?.status });
      }

      // 2) compare watermark (skip if unchanged)
      const state = loadState(statePath, logger);
      const lastSeenUploadAt = state.lastSeenUploadAt || null;

      if (!forceFetch && uploadAt && lastSeenUploadAt && String(uploadAt) === String(lastSeenUploadAt)) {
        logger.info('usb_sync:no_change_skip', {
          lastSeenUploadAt,
          uploadAt,
        });
        return { foods: [], insulins: [], scheduledBasals: [], normalBoluses: [], readings: [] };
      }

      // 3) determine fetch window
      // If CLI overrides are provided, they take absolute priority.
      let endDate = opts.glookoEndDate ? new Date(opts.glookoEndDate) : new Date();
      let startDate;

      if (opts.glookoStartDate) {
        startDate = new Date(opts.glookoStartDate);
        logger.info('window:override', { startDate: startDate.toISOString(), endDate: endDate.toISOString() });
      } else if (uploadAt) {
        // USB upload changed -> backfill with overlap
        const uploadDate = new Date(uploadAt);
        startDate = new Date(uploadDate.getTime() - overlapHours * 60 * 60 * 1000);
        logger.info('usb_sync:changed_fetch', {
          lastSeenUploadAt,
          uploadAt,
          overlapHours,
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
        });
      } else {
        // fallback: if settings missing, use last known treatments (NOT entries) with a sane minimum window
        const twoDaysAgoMs = Date.now() - 2 * 24 * 60 * 60 * 1000;
        const lastTreatMs = last_known?.treatments ? last_known.treatments.getTime() : twoDaysAgoMs;
        startDate = new Date(Math.max(twoDaysAgoMs, lastTreatMs));
        logger.info('window:fallback', {
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
          reason: 'no_settings_lastUpdatedAt',
          lastKnownTreatments: last_known?.treatments ? last_known.treatments.toISOString?.() : null,
        });
      }

      // 4) choose endpoints
      const includeCgm = process.env.CONNECT_GLOOKO_INCLUDE_CGM === '1';
      const includeFoods = process.env.CONNECT_GLOOKO_INCLUDE_FOODS === '1';
      const includeInsulins = process.env.CONNECT_GLOOKO_INCLUDE_INSULINS === '1';

      const endpoints = [];

      if (includeFoods) endpoints.push(Defaults.LatestFoods);
      if (includeInsulins) endpoints.push(Defaults.LatestInsulins);

      endpoints.push(Defaults.LatestPumpBasals);
      endpoints.push(Defaults.LatestPumpBolus);

      if (includeCgm) endpoints.push(Defaults.LatestCGMReadings);

      const urlsToFetch = endpoints.map((endpoint) => constructUrl(endpoint, patientCode, startDate, endDate));

      logger.info('fetch:start', {
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
        endpoints: urlsToFetch.map((u) => u.split('?')[0]),
        includeFoods,
        includeInsulins,
        includeCgm,
        forceFetch,
      });

      // 5) fetch all
      const results = [];
      for (const reqUrl of urlsToFetch) {
        const urlPath = reqUrl.split('?')[0];
        logger.debug('fetch:item', { urlPath });

        // IMPORTANT: do not pass "limit=maxCount" here (caused the 1+1 forever behavior)
        const resp = await httpGet(reqUrl, { headers });

        results.push({ urlPath, data: resp.data });

        // per endpoint summary
        const keys = resp.data ? Object.keys(resp.data) : [];
        logger.info('fetch:ok', { urlPath, dataKeys: keys });
      }

      // 6) map results back into batch by urlPath
      const byPath = new Map(results.map((r) => [r.urlPath, r.data]));

      const batch = {
        foods: byPath.get(Defaults.LatestFoods)?.foods,
        insulins: byPath.get(Defaults.LatestInsulins)?.insulins,
        scheduledBasals: byPath.get(Defaults.LatestPumpBasals)?.scheduledBasals,
        normalBoluses: byPath.get(Defaults.LatestPumpBolus)?.normalBoluses,
        readings: byPath.get(Defaults.LatestCGMReadings)?.readings,
      };

      logger.info('fetch:summary', {
        foods: Array.isArray(batch.foods) ? batch.foods.length : 0,
        insulins: Array.isArray(batch.insulins) ? batch.insulins.length : 0,
        scheduledBasals: Array.isArray(batch.scheduledBasals) ? batch.scheduledBasals.length : 0,
        normalBoluses: Array.isArray(batch.normalBoluses) ? batch.normalBoluses.length : 0,
        readings: Array.isArray(batch.readings) ? batch.readings.length : 0,
      });

      // 7) update watermark AFTER successful fetch (only if settings provided it)
      if (uploadAt) {
        state.lastSeenUploadAt = uploadAt;
        saveState(statePath, state, logger);
        logger.info('usb_sync:watermark_updated', { uploadAt });
      }

      return batch;
    },

    align_to_glucose() {
      // TODO
    },

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
    // Option B: manual-only mode disables the loop for testing but keeps auth wiring
    if (process.env.CONNECT_GLOOKO_MANUAL_ONLY === '1') {
      logger.warn('loop:disabled_manual_only', { env: 'CONNECT_GLOOKO_MANUAL_ONLY=1' });

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
   * Standalone runner: logs in, fetches batch, transforms.
   */
  impl.runStandalone = async function runStandalone({ lastKnownTreatmentsDate } = {}) {
    const last_known = lastKnownTreatmentsDate ? { treatments: new Date(lastKnownTreatmentsDate) } : { treatments: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) };

    logger.info('standalone:start', { lastKnownTreatmentsDate: last_known.treatments.toISOString() });

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
    glookoStartDate: input.glookoStartDate,
    glookoEndDate: input.glookoEndDate,
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

glookoSource.runStandalone = async function runStandalone(config, axios) {
  const logger = config.logger || createLogger({ name: 'glooko-standalone', level: process.env.GLOOKO_LOG_LEVEL || 'debug' });
  const impl = glookoSource({ ...config, logger }, axios);
  return impl.runStandalone({ lastKnownTreatmentsDate: config.lastKnownTreatmentsDate });
};

module.exports = glookoSource;
