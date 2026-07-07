'use strict';

const express = require('express');
const { getDb } = require('../config/database');
const { initiatePayment, verifyPayment } = require('../services/phonepe');
const { sendPaymentConfirmation, sendRegistrationRequest } = require('../services/email');
const { notify } = require('../services/notifications');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const isDev = (process.env.NODE_ENV || 'development') === 'development';

// POST /api/payments/initiate
router.post('/initiate', async (req, res) => {
  try {
    const { package_id, discount_code, use_credits, customer_name, customer_email, customer_phone } = req.body;

    const db = getDb();
    const pkg = await db.execute({ sql: `SELECT * FROM packages WHERE id = ? AND is_active = 1 AND is_trial = 0`, args: [package_id] });
    if (!pkg.rows.length) return res.status(404).json({ error: 'Package not found' });

    const packageData = pkg.rows[0];
    let amount = packageData.price;
    let discountAmount = 0;
    let discountCodeId = null;

    // Apply discount code
    if (discount_code) {
      const dc = await db.execute({
        sql: `SELECT * FROM discount_codes WHERE code = ? AND is_active = 1
              AND (expires_at IS NULL OR expires_at > datetime('now'))
              AND (max_uses IS NULL OR used_count < max_uses)`,
        args: [discount_code],
      });
      if (dc.rows.length) {
        const code = dc.rows[0];
        if (code.type === 'percentage') {
          discountAmount = (amount * code.value) / 100;
        } else {
          discountAmount = code.value;
        }
        discountCodeId = code.id;
        amount -= discountAmount;
      }
    }

    // Apply referral credits (if user is logged in)
    let creditsUsed = 0;
    if (use_credits && req.session?.user) {
      const userResult = await db.execute({ sql: `SELECT reward_credits FROM users WHERE id = ?`, args: [req.session.user.id] });
      const availableCredits = userResult.rows[0]?.reward_credits || 0;
      creditsUsed = Math.min(availableCredits, amount);
      amount -= creditsUsed;
    }

    const finalAmount = Math.max(0, amount);

    // Store payment intent in session
    req.session.paymentIntent = {
      package_id, customer_name, customer_email, customer_phone,
      original_amount: packageData.price, discount_amount: discountAmount,
      credits_used: creditsUsed, final_amount: finalAmount,
      discount_code_id: discountCodeId,
    };

    // In dev mode skip PhonePe — redirect straight to success
    if (isDev) {
      const transactionId = `DEV-${Date.now()}-${req.session?.user?.id || 'guest'}`;
      req.session.paymentIntent.transaction_id = transactionId;
      const devRedirect = `${process.env.APP_URL || 'http://localhost:3000'}/payment/success?id=${transactionId}`;
      console.log(`[payment] DEV mode — auto-approving payment ${transactionId}`);
      return res.json({ success: true, redirectUrl: devRedirect, transactionId });
    }

    const redirectUrl = `${process.env.APP_URL}/payment/success`;
    const { redirectUrl: phonePeUrl, transactionId } = await initiatePayment({
      amount: finalAmount,
      userId: req.session?.user?.id || 'guest',
      userPhone: customer_phone,
      userEmail: customer_email,
      redirectUrl,
    });

    req.session.paymentIntent.transaction_id = transactionId;
    res.json({ success: true, redirectUrl: phonePeUrl, transactionId });
  } catch (err) {
    console.error('[payment] initiate error:', err);
    res.status(500).json({ error: 'Payment initiation failed: ' + err.message });
  }
});

// GET /api/payments/verify/:transactionId
router.get('/verify/:transactionId', async (req, res) => {
  try {
    const { transactionId } = req.params;
    const intent = req.session.paymentIntent;

    if (!intent || intent.transaction_id !== transactionId) {
      return res.status(400).json({ error: 'Invalid payment session' });
    }

    // In dev mode any DEV- transaction is auto-approved
    if (isDev && transactionId.startsWith('DEV-')) {
      console.log(`[payment] DEV mode — auto-verifying ${transactionId}`);
    } else {
      const verification = await verifyPayment(transactionId);
      if (!verification.success) {
        return res.json({ success: false, status: verification.state });
      }
    }

    const db = getDb();

    // Find or create user
    let userId = req.session?.user?.id;
    if (!userId) {
      const existing = await db.execute({ sql: `SELECT id FROM users WHERE email = ?`, args: [intent.customer_email] });
      userId = existing.rows[0]?.id;
    }

    // Record payment
    const paymentResult = await db.execute({
      sql: `INSERT INTO payments (user_id, amount, discount_amount, credits_used, final_amount, method, status, transaction_id, discount_code_id)
            VALUES (?, ?, ?, ?, ?, 'phonepe', 'completed', ?, ?) RETURNING id`,
      args: [userId, intent.original_amount, intent.discount_amount, intent.credits_used,
             intent.final_amount, transactionId, intent.discount_code_id],
    });

    // Deduct credits if used
    if (intent.credits_used > 0 && userId) {
      await db.execute({
        sql: `UPDATE users SET reward_credits = reward_credits - ? WHERE id = ?`,
        args: [intent.credits_used, userId],
      });
    }

    // Update discount code usage
    if (intent.discount_code_id) {
      await db.execute({
        sql: `UPDATE discount_codes SET used_count = used_count + 1 WHERE id = ?`,
        args: [intent.discount_code_id],
      });
    }

    // Send confirmation email
    const pkg = await db.execute({ sql: `SELECT * FROM packages WHERE id = ?`, args: [intent.package_id] });
    await sendPaymentConfirmation({
      to: intent.customer_email,
      name: intent.customer_name,
      payment: { final_amount: intent.final_amount, transaction_id: transactionId },
      packageName: pkg.rows[0]?.name,
    });

    // Send registration email if not logged in
    if (!req.session?.user) {
      await sendRegistrationRequest({ to: intent.customer_email, name: intent.customer_name, packageName: pkg.rows[0]?.name });
    }

    if (userId) {
      await notify.paymentReceived(userId, intent.final_amount);
    }

    delete req.session.paymentIntent;
    res.json({ success: true, message: 'Payment verified' });
  } catch (err) {
    console.error('[payment] verify error:', err);
    res.status(500).json({ error: 'Payment verification failed' });
  }
});

// POST /api/payments/phonepe/callback
router.post('/phonepe/callback', express.raw({ type: '*/*' }), async (req, res) => {
  // PhonePe sends callback — we verify and update payment status
  res.json({ success: true });
});

// GET /api/payments/validate-code
router.get('/validate-code', async (req, res) => {
  try {
    const { code, package_id, amount } = req.query;
    const db = getDb();
    const dc = await db.execute({
      sql: `SELECT * FROM discount_codes WHERE code = ? AND is_active = 1
            AND (expires_at IS NULL OR expires_at > datetime('now'))
            AND (max_uses IS NULL OR used_count < max_uses)`,
      args: [code],
    });
    if (!dc.rows.length) return res.json({ valid: false, message: 'Invalid or expired code' });

    const discountCode = dc.rows[0];
    const baseAmount = parseFloat(amount);
    let discountAmount = discountCode.type === 'percentage'
      ? (baseAmount * discountCode.value) / 100
      : discountCode.value;

    res.json({ valid: true, type: discountCode.type, value: discountCode.value, discountAmount: discountAmount.toFixed(2) });
  } catch (err) {
    res.status(500).json({ error: 'Validation failed' });
  }
});

module.exports = router;
