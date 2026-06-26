'use strict';

const crypto = require('crypto');

const PHONEPE_BASE_URL = process.env.PHONEPE_BASE_URL || 'https://api-preprod.phonepe.com/apis/pg-sandbox';
const MERCHANT_ID      = process.env.PHONEPE_MERCHANT_ID || 'PGTESTPAYUAT';
const SALT_KEY         = process.env.PHONEPE_SALT_KEY    || '099eb0cd-02cf-4e2a-8aca-3e6c6aff0399';
const SALT_INDEX       = process.env.PHONEPE_SALT_INDEX  || '1';

/**
 * Initiate a PhonePe payment
 * @returns {Promise<{redirectUrl: string, transactionId: string}>}
 */
async function initiatePayment({ amount, userId, userPhone, userEmail, redirectUrl }) {
  const transactionId = `FIT-${Date.now()}-${userId}`;
  const amountPaise   = Math.round(amount * 100); // PhonePe uses paise

  const payload = {
    merchantId:            MERCHANT_ID,
    merchantTransactionId: transactionId,
    merchantUserId:        `USER-${userId}`,
    amount:                amountPaise,
    redirectUrl:           redirectUrl,
    redirectMode:          'REDIRECT',
    callbackUrl:           `${process.env.APP_URL}/api/payments/phonepe/callback`,
    mobileNumber:          userPhone,
    paymentInstrument: { type: 'PAY_PAGE' },
  };

  const base64Payload = Buffer.from(JSON.stringify(payload)).toString('base64');
  const checksum      = computeChecksum(base64Payload, '/pg/v1/pay');

  const response = await fetch(`${PHONEPE_BASE_URL}/pg/v1/pay`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'X-VERIFY':      checksum,
      'X-MERCHANT-ID': MERCHANT_ID,
    },
    body: JSON.stringify({ request: base64Payload }),
  });

  const data = await response.json();

  if (!data.success) {
    throw new Error(data.message || 'PhonePe payment initiation failed');
  }

  const phonePeRedirectUrl = data.data?.instrumentResponse?.redirectInfo?.url;
  return { redirectUrl: phonePeRedirectUrl, transactionId };
}

/**
 * Verify a PhonePe payment status
 */
async function verifyPayment(transactionId) {
  const path     = `/pg/v1/status/${MERCHANT_ID}/${transactionId}`;
  const checksum = computeChecksum('', path, true);

  const response = await fetch(`${PHONEPE_BASE_URL}${path}`, {
    method: 'GET',
    headers: {
      'Content-Type':  'application/json',
      'X-VERIFY':      checksum,
      'X-MERCHANT-ID': MERCHANT_ID,
    },
  });

  const data = await response.json();
  return {
    success:       data.success && data.data?.state === 'COMPLETED',
    state:         data.data?.state,
    transactionId: data.data?.merchantTransactionId,
    amount:        data.data?.amount / 100,
    raw:           data,
  };
}

/**
 * Validate PhonePe callback signature
 */
function validateCallback(base64Response, checksum) {
  const [hash] = checksum.split('###');
  const expected = crypto.createHash('sha256')
    .update(base64Response + '/pg/v1/pay' + SALT_KEY)
    .digest('hex') + `###${SALT_INDEX}`;
  return checksum === expected;
}

function computeChecksum(base64Payload, apiPath, isGet = false) {
  const data   = isGet ? apiPath + SALT_KEY : base64Payload + apiPath + SALT_KEY;
  const sha256 = crypto.createHash('sha256').update(data).digest('hex');
  return `${sha256}###${SALT_INDEX}`;
}

module.exports = { initiatePayment, verifyPayment, validateCallback };
