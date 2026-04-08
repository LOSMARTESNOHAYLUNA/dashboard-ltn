/**
 * Vercel Serverless Function
 * Archivo: api/ghl-webhook.js
 *
 * Recibe webhooks de GoHighLevel y los escribe en Firebase Firestore.
 * Eventos: ContactCreate (lead nuevo), AppointmentCreate (cita agendada)
 */

const FB_PROJECT = 'timetracker-ltn';
const FB_KEY     = 'AIzaSyBiMJCGP9L5x3qBTbD2EUZAyMEOS7v8uz8';
const FB_BASE    = `https://firestore.googleapis.com/v1/projects/${FB_PROJECT}/databases/(default)/documents`;
const GHL_TOKEN  = process.env.GHL_TOKEN;

async function fbRead(collection, docId) {
  const res = await fetch(`${FB_BASE}/${collection}/${docId}?key=${FB_KEY}`);
  return res.json();
}

async function fbPatch(collection, docId, fields) {
  const res = await fetch(`${FB_BASE}/${collection}/${docId}?key=${FB_KEY}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });
  return res.json();
}

function parseArray(field) {
  try { return JSON.parse(field?.stringValue || '[]'); }
  catch { return []; }
}

export default async function handler(req, res) {

  // Solo POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Verificar token de GHL en el header
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (GHL_TOKEN && token !== GHL_TOKEN) {
    console.warn('Token inválido recibido');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const body      = req.body;
  const eventType = body?.type || body?.event || '';

  console.log('GHL Webhook:', eventType);

  try {

    // ── LEAD NUEVO ──
    if (eventType === 'ContactCreate' || eventType === 'contact.created') {
      const c = body?.contact || body;

      const lead = {
        nombre:   `${c.firstName || ''} ${c.lastName || ''}`.trim() || 'Sin nombre',
        email:    c.email    || '',
        telefono: c.phone    || '',
        fuente:   c.source   || 'GHL',
        fase:     'Bienvenida',
        asignado: c.assignedTo || '',
        valor:    0,
        fecha:    new Date().toISOString().slice(0, 10),
        mes:      new Date().getMonth() + 1,
        año:      new Date().getFullYear(),
        ghl_id:   c.id || ''
      };

      const doc   = await fbRead('dashboard-ltn', 'new_entries');
      const leads = parseArray(doc?.fields?.leads);

      if (!leads.some(l => l.ghl_id && l.ghl_id === lead.ghl_id)) {
        leads.push(lead);
        await fbPatch('dashboard-ltn', 'new_entries', {
          leads: { stringValue: JSON.stringify(leads) }
        });
        console.log('✓ Lead guardado:', lead.nombre);
      }

      return res.status(200).json({ ok: true, action: 'lead_created', nombre: lead.nombre });
    }

    // ── CITA AGENDADA ──
    if (eventType === 'AppointmentCreate' || eventType === 'appointment.created') {
      const a    = body?.appointment || body;
      const date = new Date(a.startTime || a.date || new Date());

      const cita = {
        cliente:    a.contactName || a.title || 'Sin nombre',
        tipo:       a.calendarName?.includes('Demo')       ? 'Demo'
                  : a.calendarName?.includes('Recurrente') ? 'Recurrente'
                  : 'Otra',
        fecha:      date.toISOString().slice(0, 10),
        mes:        date.getMonth() + 1,
        año:        date.getFullYear(),
        persona:    a.assignedUserId || '',
        comentario: a.notes || a.calendarName || '',
        ghl_id:     a.id || ''
      };

      const doc   = await fbRead('dashboard-ltn', 'new_entries');
      const citas = parseArray(doc?.fields?.citas);

      if (!citas.some(c => c.ghl_id && c.ghl_id === cita.ghl_id)) {
        citas.push(cita);
        await fbPatch('dashboard-ltn', 'new_entries', {
          citas: { stringValue: JSON.stringify(citas) }
        });
        console.log('✓ Cita guardada:', cita.cliente, cita.fecha);
      }

      return res.status(200).json({ ok: true, action: 'appointment_created', cliente: cita.cliente });
    }

    // Evento no manejado — responder OK para que GHL no reintente
    return res.status(200).json({ ok: true, action: 'ignored', type: eventType });

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
