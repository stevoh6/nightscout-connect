'use strict';

const moment = require('moment');

/**
 * @param {any} batch
 * @param {number} timestampDeltaMs
 * @param {any} [logger]
 * @returns {any[]}
 */
function generate_nightscout_treatments(batch, timestampDeltaMs, logger) {
  const foods = batch?.foods || batch?.food; // accept both shapes
  const insulins = batch?.insulins;
  const pumpBoluses = batch?.normalBoluses;
  const scheduledBasals = batch?.scheduledBasals;

  const treatments = [];

  const log = logger
    ? (lvl, msg, fields) => logger[lvl]?.(msg, fields)
    : () => {}; // silent if no logger

  // Helper: safe array
  const asArray = (x) => (Array.isArray(x) ? x : []);

  const foodsArr = asArray(foods);
  const insulinsArr = asArray(insulins);

  // Foods -> Meal Bolus / Carb Correction
  if (foodsArr.length) {
    foodsArr.forEach((element) => {
      const treatment = {};
      const foodDate = new Date(element.timestamp);
      const now = moment(foodDate);

      // find insulin close to food timestamp (within 46 minutes)
      const match = insulinsArr.filter((el) => {
        const insulinDate = new Date(el.timestamp);
        const diffMin = Math.abs(moment.duration(now.diff(moment(insulinDate))).asMinutes());
        return diffMin < 46;
      });

      const insulin = match[0];

      if (insulin) {
        const insulinMoment = moment(insulin.timestamp);
        treatment.eventType = 'Meal Bolus';
        treatment.eventTime = new Date(insulinMoment.toDate()).toISOString();
        treatment.insulin = insulin.value;
        treatment.preBolus = moment.duration(moment(foodDate).diff(insulinMoment)).asMinutes();
      } else {
        const foodMoment = moment(element.timestamp);
        treatment.eventType = 'Carb Correction';
        treatment.eventTime = new Date(foodMoment.toDate()).toISOString();
      }

      treatment.carbs = element.carbs;
      treatment.notes = JSON.stringify(element);

      treatments.push(treatment);
    });
  }

  // Insulins without nearby food -> Correction Bolus
  if (insulinsArr.length) {
    insulinsArr.forEach((element) => {
      const now = moment(new Date(element.timestamp));

      const match = foodsArr.filter((el) => {
        const foodMoment = moment(new Date(el.timestamp));
        const diffMin = Math.abs(moment.duration(now.diff(foodMoment)).asMinutes());
        return diffMin < 46;
      });

      if (!match[0]) {
        const treatment = {};
        const insulinMoment = moment(element.timestamp);

        treatment.eventType = 'Correction Bolus';
        treatment.eventTime = new Date(insulinMoment.toDate()).toISOString();
        treatment.insulin = element.value;

        treatments.push(treatment);
      }
    });
  }

  // Pump boluses
  const pumpBolusArr = asArray(pumpBoluses);
  if (pumpBolusArr.length) {
    pumpBolusArr.forEach((element) => {
      const treatment = {};
      const pumpTs = new Date(element.pumpTimestamp);

      treatment.eventType = 'Meal Bolus';
      treatment.eventTime = new Date(pumpTs.getTime() + (timestampDeltaMs || 0)).toISOString();
      treatment.insulin = element.insulinDelivered;
      treatment.carbs = element.carbsInput;
      treatment.notes = JSON.stringify(element);

      treatments.push(treatment);
    });
  }

  // Scheduled basals -> Temp Basal (as you originally did)
  const basalsArr = asArray(scheduledBasals);
  if (basalsArr.length) {
    basalsArr.forEach((element) => {
      const treatment = {};
      const pumpTs = new Date(element.pumpTimestamp);

      treatment.eventType = 'Temp Basal';
      treatment.created_at = new Date(pumpTs.getTime() + (timestampDeltaMs || 0)).toISOString();
      treatment.rate = element.rate;
      treatment.absolute = element.rate;
      treatment.duration = element.duration / 60;
      treatment.notes = JSON.stringify(element);

      treatments.push(treatment);
    });
  }

  log('info', 'glooko:convert:summary', {
    foods: foodsArr.length,
    insulins: insulinsArr.length,
    pumpBoluses: pumpBolusArr.length,
    scheduledBasals: basalsArr.length,
    treatments: treatments.length,
  });

  return treatments;
}

module.exports.generate_nightscout_treatments = generate_nightscout_treatments;
