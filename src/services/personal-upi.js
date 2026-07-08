'use strict';

function getConfig() {
  return {
    upiId:     process.env.UPI_ID       || '',
    payeeName: process.env.UPI_PAYEE_NAME || 'Fitanya',
  };
}

function buildUpiLink(amount, remark) {
  const { upiId, payeeName } = getConfig();
  const base = `pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(payeeName)}&am=${amount}&cu=INR&tn=${encodeURIComponent(remark)}`;
  return {
    generic:  `upi://pay?${base}`,
    gpay:     `tez://upi/pay?${base}`,
    phonepe:  `phonepe://pay?${base}`,
    upiId,
    payeeName,
  };
}

module.exports = { getConfig, buildUpiLink };
