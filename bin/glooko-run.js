#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');

const glookoSource = require('../lib/sources/glooko');
const { createLogger } = require('../lib/sources/glooko/logger');

function arg(name, def = null) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return def;
  return process.argv[idx + 1] ?? def;
}

function sha1Hex(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex');
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '');
}

function toIsoStart(yyyyMmDd) {
  return new Date(`${yyyyMmDd}T00:00:00.000Z`).toISOString();
}

function toIsoEnd(yyyyMmDd) {
  return new Date(`${yyyyMmDd}T23:59:59.999Z`).toISOString();
}

function fingerprintTreatment(t) {
  return JSON.stringify({
    eventType: t.eventType,
    created_at: t.created_at,
    insulin: t.insulin,
    carbs: t.carbs,
    rate: t.rate,
    duration: t.duration,
    notes: t.notes, // keeps it strict; prevents accidental duplicates if notes differ
  });
}

async function fetchExistingTreatments(nsUrl, apiSecretPlain, startIso, endIso, logger) {
  const url = `${normalizeBaseUrl(nsUrl)}/api/v1/treatments.json`;
  const headers = {
    Accept: 'application/json',
    'api-secret': sha1Hex(apiSecretPlain),
  };

  const params = {
    'find[created_at][$gte]': startIso,
    'find[created_at][$lte]': endIso,
    count: 10000,
  };

  const t = logger.time('nightscout:get_treatments', { startIso, endIso });
  const res = await axios.get(url, { headers, params });
  t.end({ status: res.status, items: Array.isArray(res.data) ? res.data.length : 0 });

  return Array.isArray(res.data) ? res.data : [];
}

async function uploadTreatments(nsUrl, apiSecretPlain, treatments, { startIso, endIso, dedupe, logger }) {
  const url = `${normalizeBaseUrl(nsUrl)}/api/v1/treatments.json`;
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'api-secret': sha1Hex(apiSecretPlain),
  };

  let toUpload = treatments;

  if (dedupe && startIso && endIso) {
    const existing = await fetchExistingTreatments(nsUrl, apiSecretPlain, startIso, endIso, logger);
    const existingSet = new Set(existing.map(fingerprintTreatment));
    toUpload = treatments.filter((t) => !existingSet.has(fingerprintTreatment(t)));

    logger.info('nightscout:dedupe', {
      existing: existing.length,
      input: treatments.length,
      toUpload: toUpload.length,
    });
  }

  if (!toUpload.length) {
    logger.info('nightscout:upload:skip', { reason: 'nothing_to_upload' });
    return { uploaded: 0 };
  }

  const t = logger.time('nightscout:post_treatments', { items: toUpload.length });
  const res = await axios.post(url, toUpload, { headers });
  t.end({ status: res.status });

  logger.info('nightscout:upload:ok', { status: res.status, uploaded: toUpload.length });
  return { uploaded: toUpload.length, status: res.status };
}

async function main() {
  const logger = createLogger({ name: 'glooko-cli', level: process.env.GLOOKO_LOG_LEVEL || 'debug' });

  const outFile = arg('out', null);

  const fromArg = arg('from', null); // YYYY-MM-DD
  const toArg = arg('to', null);     // YYYY-MM-DD
  const push = arg('push', '0') === '1';

  const dedupe = arg('no-dedupe', null) ? false : true;

  const nsUrl = arg('ns', process.env.CONNECT_NIGHTSCOUT_ENDPOINT || process.env.NIGHTSCOUT_URL || null);
  const nsSecret = arg('secret', process.env.CONNECT_API_SECRET || process.env.API_SECRET || null);

  const cfgInput = {
    glookoEnv: process.env.CONNECT_GLOOKO_ENV || process.env.GLOOKO_ENV || 'eu',
    glookoServer: process.env.CONNECT_GLOOKO_SERVER || process.env.GLOOKO_SERVER,
    glookoEmail: process.env.CONNECT_GLOOKO_EMAIL || process.env.GLOOKO_EMAIL,
    glookoPassword: process.env.CONNECT_GLOOKO_PASSWORD || process.env.GLOOKO_PASSWORD,

    glookoTimezoneOffset: process.env.CONNECT_GLOOKO_TZ_OFFSET
      ? Number(process.env.CONNECT_GLOOKO_TZ_OFFSET)
      : (process.env.GLOOKO_TZ_OFFSET ? Number(process.env.GLOOKO_TZ_OFFSET) : undefined),

    // date range overrides for fetching
    glookoStartDate: fromArg ? toIsoStart(fromArg) : undefined,
    glookoEndDate: toArg ? toIsoEnd(toArg) : undefined,

    logger,
  };

  const validated = glookoSource.validate(cfgInput);
  if (!validated.ok) {
    logger.error('config:invalid', { errors: validated.errors.map((e) => e.desc) });
    process.exit(2);
  }

  logger.info('config:ok', {
    baseURL: validated.config.baseURL,
    glookoEnv: validated.config.glookoEnv,
    hasServerOverride: Boolean(validated.config.glookoServer),
    tzOffsetMs: validated.config.glookoTimezoneOffset,
    from: fromArg,
    to: toArg,
    push,
    dedupe,
  });

  const result = await glookoSource.runStandalone({ ...validated.config, logger }, axios);

  logger.info('result:summary', {
    treatments: result?.treatments?.length || 0,
    foods: Array.isArray(result?.batch?.foods) ? result.batch.foods.length : 0,
    insulins: Array.isArray(result?.batch?.insulins) ? result.batch.insulins.length : 0,
    basals: Array.isArray(result?.batch?.scheduledBasals) ? result.batch.scheduledBasals.length : 0,
    boluses: Array.isArray(result?.batch?.normalBoluses) ? result.batch.normalBoluses.length : 0,
  });

  if (outFile) {
    const abs = path.resolve(outFile);
    fs.writeFileSync(abs, JSON.stringify(result, null, 2));
    logger.info('output:wrote', { outFile: abs });
  }

  if (push) {
    if (!nsUrl || !nsSecret) {
      logger.error('nightscout:missing_config', {
        nsUrlPresent: Boolean(nsUrl),
        nsSecretPresent: Boolean(nsSecret),
      });
      process.exit(3);
    }

    const startIso = fromArg ? toIsoStart(fromArg) : null;
    const endIso = toArg ? toIsoEnd(toArg) : null;

    await uploadTreatments(nsUrl, nsSecret, result?.treatments || [], {
      startIso,
      endIso,
      dedupe,
      logger,
    });
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
