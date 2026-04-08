/**
 * Vercel Serverless Function
 * Archivo: api/ghl-webhook.js
 * 
 * Recibe webhooks de GoHighLevel y los escribe en Firebase Firestore.
 * Eventos soportados: ContactCreate (lead nuevo), AppointmentCreate (cita agendada)
 */

const FB_PROJECT = 'timetracker-ltn';
const FB_KEY     = 'AIzaSyBiMJCGP9L5x3qBTbD2EUZAyMEOS7v8uz8';
const FB_BASE    = `https://firestore.googleapis.com/v1/projects/${FB_PROJECT}/databases/(default)/documents`;

// ── Leer documento de Firestore ──
async function fbRead(collection, docId) {
  const url = `${FB_BASE}/${collection}/${docId}?key=${FB_KEY}`;
  const res = await fetch(url);
  return res.json();
}

// ── Escribir documento en Firestore ──
async function fbPatch(collection, docId, fields) {
  const url = `${FB_BASE}/${collection}/${docId}?key=${FB_KEY}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });
  return res.json();
}

// ── Parsear array de Firestore ──
function parseArray(field) {
  try {
    return JSON.parse(field?.stringValue || '[]');
  } catch {
    return [];
  }
}

// ── Handler principal ──
export default async function handler(req, res) {

  // Solo aceptar POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body;
  const eventType = body?.type || body?.event || '';

  console.log('GHL Webhook recibido:', eventType, JSON.stringify(body).slice(0, 200));

  try {

    // ════════════════════════════════════
    // LEAD NUEVO  →  ContactCreate
    // ════════════════════════════════════
    if (eventType === 'ContactCreate' || eventType === 'contact.created') {
      const contact = body?.contact || body;

      const nuevoLead = {
        nombre:   (contact.firstName || '') + ' ' + (contact.lastName || ''),
        email:    contact.email || '',
        telefono: contact.phone || '',
        fuente:   contact.source || 'GHL',
        fase:     'Bienvenida',
        asignado: contact.assignedTo || '',
        valor:    0,
        fecha:    new Date().toISOString().slice(0, 10),
        mes:      new Date().getMonth() + 1,
        año:      new Date().getFullYear(),
        ghl_id:   contact.id || ''
      };

      // Leer leads existentes de Firebase
      const doc = await fbRead('dashboard-ltn', 'new_entries');
      const leads = parseArray(doc?.fields?.leads);

      // Evitar duplicados por ghl_id
      const yaExiste = leads.some(l => l.ghl_id === nuevoLead.ghl_id);
      if (!yaExiste) {
        leads.push(nuevoLead);
        await fbPatch('dashboard-ltn', 'new_entries', {
          leads: { stringValue: JSON.stringify(leads) }
        });
        console.log('✓ Lead guardado:', nuevoLead.nombre);
      }

      return res.status(200).json({ ok: true, action: 'lead_created', nombre: nuevoLead.nombre });
    }

    // ════════════════════════════════════
    // CITA AGENDADA  →  AppointmentCreate
    // ════════════════════════════════════
    if (eventType === 'AppointmentCreate' || eventType === 'appointment.created') {
      const appt = body?.appointment || body;

      const fechaRaw = appt.startTime || appt.date || new Date().toISOString();
      const fecha    = new Date(fechaRaw);

      const nuevaCita = {
        cliente:     appt.contactName || appt.title || 'Sin nombre',
        tipo:        appt.calendarName?.includes('Demo') ? 'Demo'
                   : appt.calendarName?.includes('Recurrente') ? 'Recurrente'
                   : 'Otra',
        fecha:       fecha.toISOString().slice(0, 10),
        mes:         fecha.getMonth() + 1,
        año:         fecha.getFullYear(),
        persona:     appt.assignedUserId || '',
        comentario:  appt.notes || appt.calendarName || '',
        ghl_id:      appt.id || ''
      };

      // Leer citas existentes
      const doc = await fbRead('dashboard-ltn', 'new_entries');
      const citas = parseArray(doc?.fields?.citas);

      // Evitar duplicados
      const yaExiste = citas.some(c => c.ghl_id === nuevaCita.ghl_id);
      if (!yaExiste) {
        citas.push(nuevaCita);
        await fbPatch('dashboard-ltn', 'new_entries', {
          citas: { stringValue: JSON.stringify(citas) }
        });
        console.log('✓ Cita guardada:', nuevaCita.cliente, nuevaCita.fecha);
      }

      return res.status(200).json({ ok: true, action: 'appointment_created', cliente: nuevaCita.cliente });
    }

    // Evento no reconocido — responder OK igualmente para que GHL no reintente
    console.log('Evento no manejado:', eventType);
    return res.status(200).json({ ok: true, action: 'ignored', type: eventType });

  } catch (error) {
    console.error('Error procesando webhook:', error);
    return res.status(500).json({ error: error.message });
  }
}
