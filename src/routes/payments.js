'use strict';

const express = require('express');
const crypto  = require('crypto');
const { getDb }          = require('../config/database');
const { requireAuth }    = require('../middleware/auth');
const { notify }         = require('../services/notifications');
const {
  sendPaymentConfirmation,
  sendRegistrationRequest,
} = require('../services/email');

const router = express.Router();
const isDev  = (process.env.NODE_ENV || 'development') === 'development';
const MODE   = () => (process.env.PAYMENT_MODE || 'personal').toLowerCase();

// ── GET /api/payments/config  (frontend reads this to know which mode is active)
router.get('/config', (req, res) => {
  const mode = MODE();
  const config = { mode };
  if (mode === 'personal') {
    const { getConfig } = require('../services/personal-upi');
    Object.assign(config, getConfig());
  }
  if (mode === 'razorpay') {
    config.razorpayKeyId = process.env.RAZORPAY_KEY_ID || '';
  }
  res.json({ success: true, config });
});

// ── Shared: compute discount + credits, store paymentIntent in session
async function buildIntent(req, { package_id, discount_code, use_credits }) {
  const db = getDb();
  const pkg = await db.execute({
    sql:  `SELECT * FROM packages WHERE id = ? AND is_active = 1 AND is_trial = 0`,
    args: [package_id],
  });
  if (!pkg.rows.length) throw new Error('Package not found');
  const packageData = pkg.rows[0];

  let amount = packageData.price;
  let discountAmount = 0;
  let discountCodeId = null;

  if (discount_code) {
    const dc = await db.execute({
      sql:  `SELECT * FROM discount_codes WHERE code = ? AND is_active = 1
             AND (expires_at IS NULL OR expires_at > datetime('now'))
             AND (max_uses IS NULL OR used_count < max_uses)`,
      args: [discount_code],
    });
    if (dc.rows.length) {
      const code = dc.rows[0];
      discountAmount = code.type === 'percentage'
        ? (amount * code.value) / 100
        : code.value;
      discountCodeId = code.id;
      amount -= discountAmount;
    }
  }

  let creditsUsed = 0;
  if (use_credits && req.session?.user) {
    const userResult = await db.execute({
      sql: `SELECT reward_credits FROM users WHERE id = ?`,
      args: [req.session.user.id],
    });
    const available = userResult.rows[0]?.reward_credits || 0;
    creditsUsed = Math.min(available, amount);
    amount -= creditsUsed;
  }

  const finalAmount = Math.max(0, amount);

  req.session.paymentIntent = {
    package_id,
    customer_name:    req.body.customer_name  || req.session?.user?.name || '',
    customer_email:   req.body.customer_email || req.session?.user?.email || '',
    customer_phone:   req.body.customer_phone || '',
    original_amount:  packageData.price,
    discount_amount:  discountAmount,
    credits_used:     creditsUsed,
    final_amount:     finalAmount,
    discount_code_id: discountCodeId,
    package_name:     packageData.name,
  };

  return { finalAmount, packageData };
}

// ── Shared: activate membership after confirmed payment
async function activateMembership(db, {
  userId, packageData, intent, method, transactionId, status = 'completed',
}) {
  const paymentResult = await db.execute({
    sql:  `INSERT INTO payments
           (user_id, amount, discount_amount, credits_used, final_amount,
            method, status, transaction_id, discount_code_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    args: [
      userId, intent.original_amount, intent.discount_amount,
      intent.credits_used, intent.final_amount,
      method, status, transactionId, intent.discount_code_id,
    ],
  });

  if (status === 'completed') {
    const startD = new Date().toISOString().split('T')[0];
    const endD   = new Date(Date.now() + packageData.days * 86400000).toISOString().split('T')[0];
    await db.execute({
      sql:  `INSERT INTO memberships
             (user_id, package_id, sessions_total, sessions_used, start_date, end_date, status, is_trial)
             VALUES (?, ?, ?, 0, ?, ?, 'active', 0)`,
      args: [userId, packageData.id, packageData.sessions, startD, endD],
    });

    if (intent.credits_used > 0) {
      await db.execute({
        sql: `UPDATE users SET reward_credits = reward_credits - ? WHERE id = ?`,
        args: [intent.credits_used, userId],
      });
    }
    if (intent.discount_code_id) {
      await db.execute({
        sql: `UPDATE discount_codes SET used_count = used_count + 1 WHERE id = ?`,
        args: [intent.discount_code_id],
      });
    }
    if (userId) await notify.paymentReceived(userId, intent.final_amount).catch(() => {});
  }

  return paymentResult.rows[0].id;
}

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/payments/initiate   (PhonePe mode)
// ══════════════════════════════════════════════════════════════════════════════
router.post('/initiate', async (req, res) => {
  try {
    const mode = MODE();

    if (mode === 'razorpay') {
      // Razorpay: prepare intent, create order, return to frontend
      const { finalAmount } = await buildIntent(req, req.body);
      if (isDev) {
        const txn = `DEV-${Date.now()}`;
        req.session.paymentIntent.transaction_id = txn;
        return res.json({ success: true, mode: 'dev', transactionId: txn, finalAmount, redirectUrl: `${process.env.APP_URL || 'http://localhost:3000'}/payment/success?id=${txn}` });
      }
      const { createOrder } = require('../services/razorpay');
      const receipt = `FIT-${Date.now()}`;
      const order   = await createOrder({ amount: finalAmount, receipt });
      req.session.paymentIntent.razorpay_order_id = order.orderId;
      return res.json({ success: true, mode: 'razorpay', order, finalAmount });
    }

    if (mode === 'personal') {
      // Personal UPI: just compute intent, return amount + UPI links
      const { finalAmount } = await buildIntent(req, req.body);
      const remark = `Fitanya-${req.session.paymentIntent.package_name || 'Membership'}`;
      const { buildUpiLink } = require('../services/personal-upi');
      const links = buildUpiLink(finalAmount, remark);
      return res.json({ success: true, mode: 'personal', finalAmount, ...links });
    }

    // PhonePe mode
    const { finalAmount } = await buildIntent(req, req.body);
    if (isDev) {
      const txn = `DEV-${Date.now()}`;
      req.session.paymentIntent.transaction_id = txn;
      return res.json({ success: true, redirectUrl: `${process.env.APP_URL || 'http://localhost:3000'}/payment/success?id=${txn}`, transactionId: txn });
    }
    const { initiatePayment } = require('../services/phonepe');
    const { redirectUrl: ppUrl, transactionId } = await initiatePayment({
      amount: finalAmount,
      userId: req.session?.user?.id || 'guest',
      userPhone: req.body.customer_phone,
      userEmail: req.body.customer_email,
      redirectUrl: `${process.env.APP_URL}/payment/success`,
    });
    req.session.paymentIntent.transaction_id = transactionId;
    res.json({ success: true, mode: 'phonepe', redirectUrl: ppUrl, transactionId });
  } catch (err) {
    console.error('[payment] initiate error:', err);
    
    res.status(500).json({ error: 'Payment error. Please try again.' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/payments/razorpay/verify   (Razorpay: signature check after checkout)
// ══════════════════════════════════════════════════════════════════════════════
router.post('/razorpay/verify', async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    const intent = req.session.paymentIntent;
    if (!intent) return res.status(400).json({ error: 'No payment session' });

    if (!isDev) {
      const { verifySignature } = require('../services/razorpay');
      const valid = verifySignature({
        orderId:   razorpay_order_id,
        paymentId: razorpay_payment_id,
        signature: razorpay_signature,
      });
      if (!valid) return res.status(400).json({ error: 'Invalid payment signature' });
    }

    const db = getDb();
    let userId = req.session?.user?.id;
    if (!userId) {
      const ex = await db.execute({ sql: `SELECT id FROM users WHERE email = ?`, args: [intent.customer_email] });
      userId = ex.rows[0]?.id;
    }

    const pkg = await db.execute({ sql: `SELECT * FROM packages WHERE id = ?`, args: [intent.package_id] });
    await activateMembership(db, {
      userId, packageData: pkg.rows[0], intent,
      method: 'razorpay', transactionId: razorpay_payment_id,
    });

    sendPaymentConfirmation({ to: intent.customer_email, name: intent.customer_name, payment: { final_amount: intent.final_amount, transaction_id: razorpay_payment_id }, packageName: pkg.rows[0]?.name })
      .catch(() => {});
    if (!req.session?.user) {
      sendRegistrationRequest({ to: intent.customer_email, name: intent.customer_name, packageName: pkg.rows[0]?.name }).catch(() => {});
    }

    delete req.session.paymentIntent;
    res.json({ success: true });
  } catch (err) {
    console.error('[payment] razorpay verify error:', err);
    
    res.status(500).json({ error: 'Payment error. Please try again.' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/payments/razorpay/webhook   (server-side confirmation from Razorpay)
// ══════════════════════════════════════════════════════════════════════════════
router.post('/razorpay/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const signature = req.headers['x-razorpay-signature'];
    const secret    = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (secret) {
      const expected = crypto.createHmac('sha256', secret).update(req.body).digest('hex');
      if (expected !== signature) return res.status(400).json({ error: 'Invalid signature' });
    }
    const event = JSON.parse(req.body.toString());
    if (event.event === 'payment.captured') {
      // Payment is confirmed — idempotent, membership may already be active from client-side verify
      console.log('[razorpay webhook] payment captured:', event.payload.payment.entity.id);
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[payment] razorpay webhook error:', err);
    
    res.status(500).json({ error: 'Payment error. Please try again.' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/payments/upi/submit   (personal UPI: member says they've paid)
// ══════════════════════════════════════════════════════════════════════════════
router.post('/upi/submit', async (req, res) => {
  try {
    const intent = req.session.paymentIntent;
    if (!intent) return res.status(400).json({ error: 'No payment session' });

    const { method = 'upi' } = req.body; // gpay | phonepe | upi
    const db = getDb();

    let userId = req.session?.user?.id;
    if (!userId) {
      const ex = await db.execute({ sql: `SELECT id FROM users WHERE email = ?`, args: [intent.customer_email] });
      userId = ex.rows[0]?.id;
    }

    const transactionId = `UPI-${Date.now()}-${userId || 'guest'}`;
    const pkg = await db.execute({ sql: `SELECT * FROM packages WHERE id = ?`, args: [intent.package_id] });
    const packageData = pkg.rows[0];

    // Record payment as pending_verification
    const paymentResult = await db.execute({
      sql:  `INSERT INTO payments
             (user_id, amount, discount_amount, credits_used, final_amount,
              method, status, transaction_id, discount_code_id)
             VALUES (?, ?, ?, ?, ?, ?, 'pending_verification', ?, ?) RETURNING id`,
      args: [
        userId, intent.original_amount, intent.discount_amount,
        intent.credits_used, intent.final_amount,
        method, transactionId, intent.discount_code_id,
      ],
    });

    // Create membership in 'pending' state
    if (packageData && userId) {
      const startD = new Date().toISOString().split('T')[0];
      const endD   = new Date(Date.now() + packageData.days * 86400000).toISOString().split('T')[0];
      await db.execute({
        sql:  `INSERT INTO memberships
               (user_id, package_id, sessions_total, sessions_used,
                start_date, end_date, status, is_trial)
               VALUES (?, ?, ?, 0, ?, ?, 'pending', 0)`,
        args: [userId, packageData.id, packageData.sessions, startD, endD],
      });
    }

    delete req.session.paymentIntent;
    res.json({ success: true, transactionId, paymentId: paymentResult.rows[0].id });
  } catch (err) {
    console.error('[payment] upi submit error:', err);
    
    res.status(500).json({ error: 'Payment error. Please try again.' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/payments/verify/:transactionId   (PhonePe callback / dev auto-approve)
// ══════════════════════════════════════════════════════════════════════════════
router.get('/verify/:transactionId', async (req, res) => {
  try {
    const { transactionId } = req.params;
    const intent = req.session.paymentIntent;
    if (!intent || intent.transaction_id !== transactionId) {
      return res.status(400).json({ error: 'Invalid payment session' });
    }

    if (!isDev) {
      const { verifyPayment } = require('../services/phonepe');
      const verification = await verifyPayment(transactionId);
      if (!verification.success) return res.json({ success: false, status: verification.state });
    }

    const db = getDb();
    let userId = req.session?.user?.id;
    if (!userId) {
      const ex = await db.execute({ sql: `SELECT id FROM users WHERE email = ?`, args: [intent.customer_email] });
      userId = ex.rows[0]?.id;
    }

    const pkg = await db.execute({ sql: `SELECT * FROM packages WHERE id = ?`, args: [intent.package_id] });
    await activateMembership(db, {
      userId, packageData: pkg.rows[0], intent,
      method: 'phonepe', transactionId,
    });

    sendPaymentConfirmation({ to: intent.customer_email, name: intent.customer_name, payment: { final_amount: intent.final_amount, transaction_id: transactionId }, packageName: pkg.rows[0]?.name })
      .catch(() => {});
    if (!req.session?.user) {
      sendRegistrationRequest({ to: intent.customer_email, name: intent.customer_name, packageName: pkg.rows[0]?.name }).catch(() => {});
    }

    delete req.session.paymentIntent;
    res.json({ success: true, message: 'Payment verified' });
  } catch (err) {
    console.error('[payment] verify error:', err);
    
    res.status(500).json({ error: 'Payment verification failed' });
  }
});

// POST /api/payments/phonepe/callback
router.post('/phonepe/callback', express.raw({ type: '*/*' }), (req, res) => {
  res.json({ success: true });
});

// GET /api/payments/validate-code?code=CODE&package_id=X
router.get('/validate-code', async (req, res) => {
  try {
    const code       = (req.query.code || '').trim().toUpperCase().slice(0, 50);
    const packageId  = parseInt(req.query.package_id, 10);

    if (!code || !packageId) return res.json({ valid: false, message: 'Code and package required' });

    const db = getDb();

    // Look up the real package price — never trust client-supplied amount
    const pkg = await db.execute({
      sql: `SELECT price FROM packages WHERE id = ? AND is_active = 1`,
      args: [packageId],
    });
    if (!pkg.rows.length) return res.json({ valid: false, message: 'Package not found' });
    const base = pkg.rows[0].price;

    const dc = await db.execute({
      sql:  `SELECT * FROM discount_codes WHERE code = ? AND is_active = 1
             AND (expires_at IS NULL OR expires_at > datetime('now'))
             AND (max_uses IS NULL OR used_count < max_uses)`,
      args: [code],
    });
    if (!dc.rows.length) return res.json({ valid: false, message: 'Invalid or expired code' });
    const discountCode   = dc.rows[0];

    // Check min_amount against real package price
    if (discountCode.min_amount && base < discountCode.min_amount) {
      return res.json({ valid: false, message: `Minimum order ₹${discountCode.min_amount} required` });
    }

    const discountAmount = discountCode.type === 'percentage'
      ? (base * discountCode.value) / 100
      : Math.min(discountCode.value, base);

    res.json({ valid: true, type: discountCode.type, value: discountCode.value, discountAmount: discountAmount.toFixed(2) });
  } catch (err) {
    console.error('[payments] validate-code error:', err.message);
    res.status(500).json({ error: 'Validation failed' });
  }
});

module.exports = router;
