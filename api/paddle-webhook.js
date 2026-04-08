// /api/paddle-webhook.js — Vercel Serverless Function
// Handles Paddle webhook events to update user plans in Supabase
//
// SETUP:
// 1. In Paddle Dashboard → Developer Tools → Notifications → Create
// 2. URL: https://getwealthos.app/api/paddle-webhook
// 3. Events: subscription.created, subscription.updated, subscription.cancelled
// 4. Copy webhook secret → add to Vercel env as PADDLE_WEBHOOK_SECRET
// 5. Also add SUPABASE_SERVICE_KEY (from Supabase → Settings → API → service_role key)

import { createHmac } from 'crypto';

const SUPABASE_URL = 'https://qaqhrmqqbxpzuwyfbbwy.supabase.co';

function verifySignature(rawBody, signature, secret) {
  if (!secret || !signature) return false;
  try {
    // Paddle sends ts;h1=hash format
    const parts = signature.split(';');
    const tsPart = parts.find(p => p.startsWith('ts='));
    const h1Part = parts.find(p => p.startsWith('h1='));
    if (!tsPart || !h1Part) return false;
    const ts = tsPart.split('=')[1];
    const h1 = h1Part.split('=')[1];
    const payload = ts + ':' + rawBody;
    const computed = createHmac('sha256', secret).update(payload).digest('hex');
    return computed === h1;
  } catch (e) {
    console.error('Signature verification error:', e);
    return false;
  }
}

async function updateUserPlan(email, supabaseId, plan) {
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!serviceKey) {
    console.error('SUPABASE_SERVICE_KEY not set');
    return false;
  }

  try {
    // Find user by email using admin API
    const listRes = await fetch(
      `${SUPABASE_URL}/auth/v1/admin/users?page=1&per_page=50`,
      {
        headers: {
          'Authorization': `Bearer ${serviceKey}`,
          'apikey': serviceKey,
        },
      }
    );

    if (!listRes.ok) {
      console.error('Failed to list users:', listRes.status);
      return false;
    }

    const listData = await listRes.json();
    const users = listData.users || listData || [];
    const user = users.find(u => u.email === email || u.id === supabaseId);

    if (!user) {
      console.error('User not found:', email, supabaseId);
      return false;
    }

    // Update user metadata with new plan
    const updateRes = await fetch(
      `${SUPABASE_URL}/auth/v1/admin/users/${user.id}`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${serviceKey}`,
          'apikey': serviceKey,
        },
        body: JSON.stringify({
          user_metadata: {
            ...user.user_metadata,
            plan: plan,
            plan_updated_at: new Date().toISOString(),
          },
        }),
      }
    );

    if (!updateRes.ok) {
      const errBody = await updateRes.text();
      console.error('Failed to update user plan:', updateRes.status, errBody);
      return false;
    }

    console.log(`Plan updated (metadata): ${email} → ${plan}`);

    // Also update public.users.plan table (frontend reads from here via syncPlanFromDB)
    try {
      // Use POST with upsert to create row if it doesn't exist
      const dbRes = await fetch(
        `${SUPABASE_URL}/rest/v1/users`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${serviceKey}`,
            'apikey': serviceKey,
            'Prefer': 'resolution=merge-duplicates,return=minimal',
          },
          body: JSON.stringify({ id: user.id, email: email, plan: plan }),
        }
      );
      if (dbRes.ok) {
        console.log(`Plan updated (public.users): ${email} → ${plan}`);
      } else {
        const errText = await dbRes.text();
        console.warn('public.users upsert failed:', dbRes.status, errText);
      }
    } catch (dbErr) {
      console.warn('public.users upsert error:', dbErr.message);
    }

    return true;
  } catch (e) {
    console.error('updateUserPlan error:', e);
    return false;
  }
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ status: 'Paddle webhook endpoint active' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const secret = process.env.PADDLE_WEBHOOK_SECRET;
    const signature = req.headers['paddle-signature'] || '';

    // Get raw body for signature verification
    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);

    // Verify webhook signature (skip in development if no secret set)
    if (secret && !verifySignature(rawBody, signature, secret)) {
      console.error('Invalid webhook signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const event = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const eventType = event.event_type || '';
    const data = event.data || {};

    console.log('Paddle webhook:', eventType);

    // Extract customer info - check customData first, then customer object
    const customData = data.custom_data || {};
    const customerEmail = data.customer ? (data.customer.email || '') : '';
    const email = customData.email || customerEmail;
    const supabaseId = customData.supabaseId || '';

    if (!email && !supabaseId) {
      console.error('No user identifier in webhook data');
      return res.status(200).json({ received: true, warning: 'No user identifier' });
    }

    let newPlan = null;

    switch (eventType) {
      case 'subscription.created':
      case 'subscription.activated':
      case 'subscription.updated': {
        const status = data.status || '';
        if (status === 'active' || status === 'trialing') {
          // Determine plan from price ID
          const items = data.items || [];
          const priceId = (items.length > 0 && items[0].price) ? items[0].price.id : '';
          // Map price ID to plan
          const PRIVATE_PRICE_ID = 'pri_01kmjb5rsd19dqga99vcxmegda';
          newPlan = (priceId === PRIVATE_PRICE_ID) ? 'private' : 'pro';
          console.log(`Subscription ${status}: ${email} → ${newPlan} (price: ${priceId})`);
        } else if (status === 'past_due' || status === 'paused') {
          // Keep pro for grace period
          console.log(`Subscription ${status}: ${email} — keeping current plan`);
        }
        break;
      }

      case 'subscription.cancelled':
      case 'subscription.canceled': {
        // Downgrade to free
        newPlan = 'free';
        console.log(`Subscription cancelled: ${email} → free`);
        break;
      }

      default:
        console.log('Unhandled event type:', eventType);
    }

    if (newPlan) {
      const success = await updateUserPlan(email, supabaseId, newPlan);
      return res.status(200).json({ received: true, plan: newPlan, updated: success });
    }

    return res.status(200).json({ received: true });

  } catch (err) {
    console.error('Webhook handler error:', err);
    // Always return 200 to Paddle to prevent retries on our errors
    return res.status(200).json({ received: true, error: err.message });
  }
}