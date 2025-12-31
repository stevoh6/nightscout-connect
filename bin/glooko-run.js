#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const glookoSource = require('../lib/sources/glooko');
const { createLogger } = require('../lib/sources/glooko/logger');

function arg(name, def = null) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return def;
  return process.argv[idx + 1] ?? def;
}

async function main() {
  const logger = createLogger({ name: 'glooko-cli', level: process.env.GLOOKO_LOG_LEVEL || 'debug' });

  const outFile = arg('out', null);
  const lastKnown = arg('lastKnown', null); // ISO date (optional)

  // Required env vars
  const cfg = {
    glookoEnv: process.env.CONNECT_GLOOKO_ENV || process.env.GLOOKO_ENV || 'eu',
    glookoServer: process.env.CONNECT_GLOOKO_SERVER || process.env.GLOOKO_SERVER,
    glookoEmail: process.env.CONNECT_GLOOKO_EMAIL || process.env.GLOOKO_EMAIL,
    glookoPassword: process.env.CONNECT_GLOOKO_PASSWORD || process.env.GLOOKO_PASSWORD,

    // timezone offset HOURS (same style your validate expects)
    glookoTimezoneOffset: process.env.CONNECT_GLOOKO_TZ_OFFSET
      ? Number(process.env.CONNECT_GLOOKO_TZ_OFFSET)
      : (process.env.GLOOKO_TZ_OFFSET ? Number(process.env.GLOOKO_TZ_OFFSET) : undefined),

    // retries
    glookoMaxRetries: process.env.GLOOKO_MAX_RETRIES ? Number(process.env.GLOOKO_MAX_RETRIES) : undefined,
    glookoRetryDelayMs: process.env.GLOOKO_RETRY_DELAY_MS ? Number(process.env.GLOOKO_RETRY_DELAY_MS) : undefined,

    logger,
  };

  const validated = glookoSource.validate(cfg);
  if (!validated.ok) {
    logger.error('config:invalid', { errors: validated.errors.map((e) => e.desc) });
    process.exit(2);
  }

  logger.info('config:ok', {
    baseURL: validated.config.baseURL,
    glookoEnv: validated.config.glookoEnv,
    hasServerOverride: Boolean(validated.config.glookoServer),
    tzOffsetMs: validated.config.glookoTimezoneOffset,
  });

  const result = await glookoSource.runStandalone(
    { ...validated.config, logger, lastKnownEntriesDate: lastKnown || undefined },
    axios
  );

  if (outFile) {
    const abs = path.resolve(outFile);
    fs.writeFileSync(abs, JSON.stringify(result, null, 2));
    logger.info('output:wrote', { outFile: abs });
  } else {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ treatments: result?.treatments?.length || 0 }, null, 2));
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
