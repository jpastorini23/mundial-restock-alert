import { Resend } from 'resend';
import { readFile, writeFile } from 'node:fs/promises';

const URL = 'https://zonakids.com/';
const STATE_FILE = './state.json';

const MONITORED_ITEMS = [
  {
    id: 'combo-gold-100',
    short: 'COMBO GOLD',
    full: 'COMBO 1 álbum GOLD + 100 sobres FIFA WORLD CUP 2026',
    namePattern: /COMBO\s+1\s+(?:álbum|album)\s+GOLD\s+\+\s+100\s+sobres/i,
  },
  {
    id: 'combo-25',
    short: 'COMBO + 25 sobres',
    full: 'COMBO 1 álbum + 25 sobres FIFA WORLD CUP 2026',
    namePattern: /COMBO\s+1\s+(?:álbum|album)\s+\+\s+25\s+sobres\s+de\s+figuritas\s+FIFA/i,
  },
  {
    id: '25-sobres',
    short: '25 Sobres',
    full: '25 Sobres De Figuritas FIFA WORLD CUP 2026',
    // Negative lookbehind excludes the "+ 25 sobres..." substring inside the combo-25 name.
    namePattern: /(?<!\+\s)25\s+Sobres\s+De\s+Figuritas\s+FIFA\s+WORLD\s+CUP/i,
  },
  {
    id: 'combo-tapa-dura',
    short: 'COMBO TAPA DURA',
    full: 'COMBO 1 álbum TAPA DURA + 50 sobres FIFA WORLD CUP 2026',
    namePattern: /COMBO\s+1\s+(?:álbum|album)\s+TAPA\s+DURA\s+\+\s+50\s+sobres/i,
  },
];

const CARRITO_RE = /A[ñn]adir\s+al\s+Carrito/i;
const AVISAME_RE = /Av[ií]same/i;

const HTML_ENTITIES = {
  '&aacute;': 'á', '&eacute;': 'é', '&iacute;': 'í', '&oacute;': 'ó', '&uacute;': 'ú',
  '&Aacute;': 'Á', '&Eacute;': 'É', '&Iacute;': 'Í', '&Oacute;': 'Ó', '&Uacute;': 'Ú',
  '&ntilde;': 'ñ', '&Ntilde;': 'Ñ', '&amp;': '&', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ',
};

function decodeEntities(str) {
  return str.replace(/&(?:aacute|eacute|iacute|oacute|uacute|Aacute|Eacute|Iacute|Oacute|Uacute|ntilde|Ntilde|amp|quot|apos|nbsp);/g, (m) => HTML_ENTITIES[m] || m);
}

async function fetchPageOnce() {
  const res = await fetch(URL, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'es-AR,es;q=0.9,en;q=0.8',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${URL}`);
  return res.text();
}

async function fetchPage() {
  // Retry once on transient errors (network blip, brief 5xx).
  try {
    return await fetchPageOnce();
  } catch (err) {
    console.warn(`First fetch failed (${err.message}). Retrying in 2s...`);
    await new Promise((r) => setTimeout(r, 2000));
    return await fetchPageOnce();
  }
}

function parseStock(html) {
  const result = {};
  for (const item of MONITORED_ITEMS) result[item.id] = 'NO_LISTADO';

  const positions = [];
  for (const item of MONITORED_ITEMS) {
    const pattern = new RegExp(item.namePattern.source, 'gi');
    for (const match of html.matchAll(pattern)) {
      positions.push({ id: item.id, idx: match.index });
    }
  }
  if (positions.length === 0) return result;

  positions.sort((a, b) => a.idx - b.idx);

  const observations = {};
  for (let i = 0; i < positions.length; i++) {
    const { id, idx } = positions[i];
    // Window ends at the next match belonging to a DIFFERENT item (or +5000 chars).
    // This avoids same-item duplicates (e.g. title attr + visible heading) shrinking the window below the button.
    let nextBoundary = idx + 5000;
    for (let j = i + 1; j < positions.length; j++) {
      if (positions[j].id !== id) {
        nextBoundary = Math.min(positions[j].idx, idx + 5000);
        break;
      }
    }
    const window = html.slice(idx, nextBoundary);

    const carritoIdx = window.search(CARRITO_RE);
    const avisameIdx = window.search(AVISAME_RE);

    let status;
    if (carritoIdx === -1 && avisameIdx === -1) status = 'UNKNOWN';
    else if (carritoIdx === -1) status = 'AVISAME';
    else if (avisameIdx === -1) status = 'CARRITO';
    else status = carritoIdx < avisameIdx ? 'CARRITO' : 'AVISAME';

    (observations[id] ||= []).push(status);
  }

  for (const item of MONITORED_ITEMS) {
    const obs = observations[item.id];
    if (!obs || obs.length === 0) continue;
    if (obs.includes('CARRITO')) result[item.id] = 'CARRITO';
    else if (obs.includes('AVISAME')) result[item.id] = 'AVISAME';
    else result[item.id] = 'UNKNOWN';
  }

  return result;
}

async function readState() {
  try {
    const content = await readFile(STATE_FILE, 'utf8');
    return JSON.parse(content);
  } catch {
    return Object.fromEntries(MONITORED_ITEMS.map((i) => [i.id, 'AVISAME']));
  }
}

async function writeState(state) {
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

async function sendAlert(changedItems) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.NOTIFY_EMAIL;
  if (!apiKey) throw new Error('RESEND_API_KEY not set');
  if (!to) throw new Error('NOTIFY_EMAIL not set');

  const resend = new Resend(apiKey);
  const shortList = changedItems.map((i) => i.short).join(', ');
  const itemsHtml = changedItems.map((i) => `<li><strong>${i.full}</strong></li>`).join('');

  const { error } = await resend.emails.send({
    from: 'Zonakids Stock Alert <onboarding@resend.dev>',
    to,
    subject: `🚨 Stock zonakids: ${shortList}`,
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;max-width:560px;margin:0 auto;padding:24px;">
        <h2 style="color:#e63946;margin:0 0 16px;">¡Stock disponible!</h2>
        <p style="color:#333;font-size:15px;line-height:1.5;">
          Los siguientes items del Mundial pasaron a estar disponibles en
          <a href="https://zonakids.com/" style="color:#e63946;">zonakids.com</a>:
        </p>
        <ul style="color:#333;font-size:15px;line-height:1.7;">${itemsHtml}</ul>
        <p style="margin-top:24px;">
          <a href="https://zonakids.com/" style="display:inline-block;padding:12px 24px;background:#e63946;color:white;text-decoration:none;border-radius:6px;font-weight:bold;font-size:15px;">
            Comprar ahora →
          </a>
        </p>
        <p style="color:#888;font-size:12px;margin-top:32px;border-top:1px solid #eee;padding-top:16px;">
          Aviso automático generado por tu monitor de stock.
          El stock puede irse en minutos — entrá ya.
        </p>
      </div>
    `,
  });

  if (error) throw new Error(`Resend error: ${JSON.stringify(error)}`);
}

async function main() {
  console.log(`[${new Date().toISOString()}] Checking ${URL}...`);

  const html = decodeEntities(await fetchPage());
  const current = parseStock(html);
  const previous = await readState();

  console.log('Previous state:', previous);
  console.log('Current state:', current);

  const changed = [];
  for (const item of MONITORED_ITEMS) {
    const prev = previous[item.id] || 'AVISAME';
    const curr = current[item.id];
    if (prev === 'AVISAME' && curr === 'CARRITO') changed.push(item);
  }

  if (changed.length > 0) {
    console.log(`📧 STOCK DETECTED: ${changed.map((i) => i.short).join(', ')} — sending alert...`);
    await sendAlert(changed);
    console.log('Alert sent.');
  } else {
    console.log('No AVISAME → CARRITO transitions. No alert sent.');
  }

  // Only write stock fields — no timestamp — so the file only changes (and gets committed) when stock actually changes.
  await writeState(current);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
