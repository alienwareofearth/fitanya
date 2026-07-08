'use strict';

const crypto = require('crypto');
const Razorpay = require('razorpay');

function getClient() {
  return new Razorpay({
    key_id:     process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
}

async function createOrder({ amount, currency = 'INR', receipt }) {
  const rz = getClient();
  const order = await rz.orders.create({
    amount:   Math.round(amount * 100), // paise
    currency,
    receipt,
    payment_capture: 1,
  });
  return { orderId: order.id, amount: order.amount, currency: order.currency };
}

function verifySignature({ orderId, paymentId, signature }) {
  const body    = `${orderId}|${paymentId}`;
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(body)
    .digest('hex');
  return expected === signature;
}

module.exports = { createOrder, verifySignature };
