/**
 * Vercel Serverless Function — api/stripe-webhook.js
 * Recibe webhooks de Stripe y los escribe en Firebase Firestore.
 * Eventos: charge.succeeded, invoice.paid, customer.subscription.created
 */

const FB_PROJECT = 'timetracker-ltn';
const FB_KEY     = 'AIzaSyBiMJCGP9L5x3qBTbD2EUZAyMEOS7v8uz8';
const FB_BASE    = `https://firestore.googleapis.com/v1/projects/${FB_PROJECT}/databases/(default)/documents`;
const STRIPE_KEY    = process.env.STRIPE_SECRET_KEY;
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// ── Firebase helpers ──
async function fbRead(col, doc) {
  const res = await fetch(`${FB_BASE}/${col}/${doc}?key=${FB_KEY}`);
  return res.json();
}

async function fbPatch(col, doc, fields) {
  const res = await fetch(`${FB_BASE}/${col}/${doc}?key=${FB_KEY}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });
  return res.json();
}

function parseArr(field) {
  try { return JSON.parse(field?.stringValue || '[]'); }
  catch { return []; }
}

// ── Leer body raw (necesario para verificar firma de Stripe) ──
async function readRawBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
  });
}

// ── Verificar firma de Stripe manualmente (sin SDK) ──
async function verifyStripeSignature(rawBody, signature, secret) {
  if (!signature || !secret) return true; // saltar si no hay secret configurado

  const parts = signature.split(',');
  const tPart = parts.find(p => p.startsWith('t='));
  const v1Part = parts.find(p => p.startsWith('v1='));
  if (!tPart || !v1Part) return false;

  const timestamp = tPart.slice(2);
  const expectedSig = v1Part.slice(3);
  const payload = `${timestamp}.${rawBody}`;

  // Importar crypto para HMAC
  const { createHmac } = await import('crypto');
  const computedSig = createHmac('sha256', secret).update(payload).digest('hex');

  return computedSig === expectedSig;
}

// ── Obtener nombre del cliente desde Stripe ──
async function getCustomerName(customerId) {
  if (!customerId || !STRIPE_KEY) return '';
  try {
    const res = await fetch(`https://api.stripe.com/v1/customers/${customerId}`, {
      headers: { 'Authorization': `Bearer ${STRIPE_KEY}` }
    });
    const customer = await res.json();
    return customer.name || customer.email || customerId;
  } catch {
    return customerId;
  }
}

// ── Handler principal ──
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Leer body raw para verificar firma
  const rawBody  = await readRawBody(req);
  const signature = req.headers['stripe-signature'];

  // Verificar que el webhook viene realmente de Stripe
  const isValid = await verifyStripeSignature(rawBody, signature, WEBHOOK_SECRET);
  if (!isValid) {
    console.error('Firma de Stripe inválida');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const eventType = event.type;
  console.log('Stripe event:', eventType);

  try {
    const now   = new Date();
    const mes   = now.getMonth() + 1;
    const año   = now.getFullYear();
    const fecha = now.toISOString().slice(0, 10);

    // ════════════════════════════════════
    // PAGO COMPLETADO — charge.succeeded
    // ════════════════════════════════════
    if (eventType === 'charge.succeeded') {
      const charge = event.data.object;
      const importe = (charge.amount || 0) / 100; // Stripe usa centavos

      // Ignorar pagos de 0€
      if (importe === 0) return res.status(200).json({ ok: true, action: 'ignored_zero' });

      const clienteNombre = charge.billing_details?.name
        || await getCustomerName(charge.customer)
        || 'Cliente Stripe';

      const entrada = {
        cliente:    clienteNombre,
        item:       charge.description || 'Pago Stripe',
        importe:    importe,
        moneda:     (charge.currency || 'eur').toUpperCase(),
        mes:        mes,
        año:        año,
        fecha:      fecha,
        stripe_id:  charge.id,
        fuente:     'Stripe'
      };

      const doc = await fbRead('dashboard-ltn', 'new_entries');
      const fac = parseArr(doc?.fields?.fac);

      if (!fac.some(f => f.stripe_id === entrada.stripe_id)) {
        fac.push(entrada);
        await fbPatch('dashboard-ltn', 'new_entries', {
          fac: { stringValue: JSON.stringify(fac) }
        });
        console.log('✓ Pago guardado:', clienteNombre, importe + '€');
      }

      return res.status(200).json({ ok: true, action: 'charge_saved', cliente: clienteNombre, importe });
    }

    // ════════════════════════════════════
    // FACTURA PAGADA — invoice.paid
    // ════════════════════════════════════
    if (eventType === 'invoice.paid') {
      const invoice = event.data.object;
      const importe = (invoice.amount_paid || 0) / 100;

      if (importe === 0) return res.status(200).json({ ok: true, action: 'ignored_zero' });

      const clienteNombre = await getCustomerName(invoice.customer) || 'Cliente Stripe';

      const entrada = {
        cliente:   clienteNombre,
        item:      invoice.description || invoice.number || 'Factura Stripe',
        importe:   importe,
        moneda:    (invoice.currency || 'eur').toUpperCase(),
        mes:       mes,
        año:       año,
        fecha:     fecha,
        stripe_id: invoice.id,
        fuente:    'Stripe'
      };

      const doc = await fbRead('dashboard-ltn', 'new_entries');
      const fac = parseArr(doc?.fields?.fac);

      if (!fac.some(f => f.stripe_id === entrada.stripe_id)) {
        fac.push(entrada);
        await fbPatch('dashboard-ltn', 'new_entries', {
          fac: { stringValue: JSON.stringify(fac) }
        });
        console.log('✓ Factura guardada:', clienteNombre, importe + '€');
      }

      return res.status(200).json({ ok: true, action: 'invoice_saved', cliente: clienteNombre, importe });
    }

    // ════════════════════════════════════
    // SUSCRIPCIÓN NUEVA — customer.subscription.created
    // ════════════════════════════════════
    if (eventType === 'customer.subscription.created') {
      const sub = event.data.object;
      const clienteNombre = await getCustomerName(sub.customer) || 'Cliente Stripe';

      // Obtener importe del primer ítem de la suscripción
      const importe = ((sub.items?.data?.[0]?.price?.unit_amount || 0) / 100);
      const plan    = sub.items?.data?.[0]?.price?.nickname || sub.items?.data?.[0]?.price?.id || 'Suscripción';

      const nuevoCliente = {
        nombre:       clienteNombre,
        plan:         plan,
        estado:       'Activo',
        fecha_inicio: fecha,
        stripe_id:    sub.customer,
        fuente:       'Stripe'
      };

      const doc = await fbRead('dashboard-ltn', 'new_entries');
      const cli = parseArr(doc?.fields?.cli);

      if (!cli.some(c => c.stripe_id === nuevoCliente.stripe_id)) {
        cli.push(nuevoCliente);
        await fbPatch('dashboard-ltn', 'new_entries', {
          cli: { stringValue: JSON.stringify(cli) }
        });
        console.log('✓ Suscripción guardada:', clienteNombre, plan);
      }

      return res.status(200).json({ ok: true, action: 'subscription_saved', cliente: clienteNombre, plan });
    }

    // Evento no manejado
    console.log('Evento no manejado:', eventType);
    return res.status(200).json({ ok: true, action: 'ignored', type: eventType });

  } catch (error) {
    console.error('Error:', error.message);
    return res.status(500).json({ error: error.message });
  }
}
