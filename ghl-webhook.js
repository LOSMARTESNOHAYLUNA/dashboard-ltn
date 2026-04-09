/**
 * Vercel Serverless Function — api/ghl-webhook.js
 * Recibe webhooks de GHL y los escribe en Firebase Firestore.
 */

const FB_PROJECT = 'timetracker-ltn';
const FB_KEY     = 'AIzaSyBiMJCGP9L5x3qBTbD2EUZAyMEOS7v8uz8';
const FB_BASE    = `https://firestore.googleapis.com/v1/projects/${FB_PROJECT}/databases/(default)/documents`;

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

// Leer body raw y parsearlo manualmente
async function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch { resolve({}); }
    });
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Parsear body — Vercel a veces no lo parsea automáticamente
  let body = req.body;
  if (!body || Object.keys(body).length === 0) {
    body = await readBody(req);
  }

  // Log completo para debug
  console.log('GHL Webhook body:', JSON.stringify(body).slice(0, 500));

  const eventType = body?.type || body?.event || body?.eventType || '';
  console.log('Event type:', eventType);

  try {

    // ── LEAD NUEVO ──
    if (
      eventType === 'ContactCreate' ||
      eventType === 'contact.created' ||
      eventType === 'CONTACT_CREATE' ||
      body?.contact || body?.email || body?.firstName
    ) {
      const c = body?.contact || body;

      const lead = {
        nombre:   `${c.firstName || c.first_name || ''} ${c.lastName || c.last_name || ''}`.trim() || c.name || c.contactName || 'Sin nombre',
        email:    c.email    || '',
        telefono: c.phone    || c.phone_number || '',
        fuente:   c.source   || c.attributionSource?.medium || 'GHL',
        fase:     'Bienvenida',
        asignado: c.assignedTo || c.assignedUserId || '',
        valor:    0,
        fecha:    new Date().toISOString().slice(0, 10),
        mes:      new Date().getMonth() + 1,
        año:      new Date().getFullYear(),
        ghl_id:   c.id || c.contactId || ''
      };

      console.log('Lead a guardar:', JSON.stringify(lead));

      const doc   = await fbRead('dashboard-ltn', 'new_entries');
      const leads = parseArr(doc?.fields?.leads);
      if (!leads.some(l => l.ghl_id && l.ghl_id === lead.ghl_id)) {
        leads.push(lead);
        await fbPatch('dashboard-ltn', 'new_entries', {
          leads: { stringValue: JSON.stringify(leads) }
        });
        console.log('✓ Lead guardado:', lead.nombre);
      } else {
        console.log('Lead ya existía, ignorado');
      }

      return res.status(200).json({ ok: true, action: 'lead_created', nombre: lead.nombre });
    }

    // ── CITA AGENDADA ──
    if (
      eventType === 'AppointmentCreate' ||
      eventType === 'appointment.created' ||
      eventType === 'APPOINTMENT_CREATE' ||
      body?.appointment || body?.startTime || body?.calendarId
    ) {
      const a    = body?.appointment || body;
      const date = new Date(a.startTime || a.start_time || a.date || new Date());

      const cita = {
        cliente:    a.contactName || a.contact_name || a.title || 'Sin nombre',
        tipo:       (a.calendarName || a.calendar_name || '').includes('Demo')       ? 'Demo'
                  : (a.calendarName || a.calendar_name || '').includes('Recurrente') ? 'Recurrente'
                  : 'Otra',
        fecha:      date.toISOString().slice(0, 10),
        mes:        date.getMonth() + 1,
        año:        date.getFullYear(),
        persona:    a.assignedUserId || a.assigned_user_id || '',
        comentario: a.notes || a.calendarName || a.calendar_name || '',
        ghl_id:     a.id || a.appointmentId || ''
      };

      console.log('Cita a guardar:', JSON.stringify(cita));

      const doc   = await fbRead('dashboard-ltn', 'new_entries');
      const citas = parseArr(doc?.fields?.citas);
      if (!citas.some(c => c.ghl_id && c.ghl_id === cita.ghl_id)) {
        citas.push(cita);
        await fbPatch('dashboard-ltn', 'new_entries', {
          citas: { stringValue: JSON.stringify(citas) }
        });
        console.log('✓ Cita guardada:', cita.cliente, cita.fecha);
      }

      return res.status(200).json({ ok: true, action: 'appointment_created', cliente: cita.cliente });
    }

    console.log('Evento no reconocido — body completo:', JSON.stringify(body));
    return res.status(200).json({ ok: true, action: 'ignored', type: eventType, body_keys: Object.keys(body) });

  } catch (error) {
    console.error('Error:', error.message);
    return res.status(500).json({ error: error.message });
  }
}
