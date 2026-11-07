// Organizador: widget de Scriptable (iOS). Sin dependencias ni secretos en el repo.
// Primera vez: ejecutalo dentro de Scriptable y elige "Configurar token" (token maestro de la app,
// guardado en el Keychain). Tras un 401/403 deja de llamar a la API hasta reconfigurar el token.
const API = 'https://organizador-api.jose-dcp20.workers.dev';
const KEY = 'organizador_token';
const STALE_MS = 20 * 60 * 1000;
const RETRY_MS = 15 * 60 * 1000;

const fm = FileManager.local();
const file = fm.joinPath(fm.documentsDirectory(), 'organizador-widget.json');

// state: { data, fetchedAt, block: 'auth' | 'forbidden' | null, until: epoch ms (429) }
function load() {
  try {
    return JSON.parse(fm.readString(file));
  } catch (_e) {
    return {};
  }
}
function save(state) {
  fm.writeString(file, JSON.stringify(state));
}

async function refresh(state) {
  const token = Keychain.contains(KEY) ? Keychain.get(KEY) : null;
  if (!token) return { ...state, error: 'Abre Scriptable para configurar' };
  if (state.block === 'auth') return { ...state, error: 'Token invalido' };
  if (state.block === 'forbidden') return { ...state, error: 'Token sin permiso' };
  if (state.until && Date.now() < state.until) return state;
  try {
    const req = new Request(`${API}/api/widget/today`);
    req.headers = { Authorization: `Bearer ${token}` };
    req.timeoutInterval = 10;
    const body = await req.loadJSON();
    const code = req.response.statusCode;
    if (code === 200) return { data: body, fetchedAt: Date.now(), block: null, until: 0 };
    if (code === 401) return { ...state, block: 'auth', error: 'Token invalido' };
    if (code === 403) return { ...state, block: 'forbidden', error: 'Token sin permiso' };
    if (code === 429) {
      const secs = Number(
        req.response.headers['Retry-After'] || req.response.headers['retry-after'],
      );
      return {
        ...state,
        until: Date.now() + (secs > 0 ? secs * 1000 : RETRY_MS),
        error: 'Limitado',
      };
    }
    return { ...state, error: `Error ${code}` };
  } catch (_e) {
    return { ...state, error: 'Sin conexion' };
  }
}

const ev = (e) => (e.time ? `${e.time} ` : '') + e.title;
const pending = (d) => d.todayTotal - d.todayDone;

function fill(w, family, state) {
  const d = state.data;
  const small = family === 'small';
  const add = (text, size, gray) => {
    const t = w.addText(text);
    t.font = Font.systemFont(size);
    t.lineLimit = 1;
    if (gray) t.textColor = Color.gray();
    return t;
  };
  if (!d) {
    add(state.error || 'Sin datos', 12);
    return;
  }
  if (d.v !== 1) {
    add('Actualiza el script', 12);
    return;
  }
  if (family === 'accessoryInline') {
    add(
      d.next
        ? ev(d.next)
        : d.todayTotal
          ? `Hoy: ${d.todayDone}/${d.todayTotal} hechos`
          : 'Sin mas eventos',
      12,
    );
    return;
  }
  if (family === 'accessoryCircular') {
    w.addSpacer();
    const t = add(String(pending(d)), 24);
    t.centerAlignText();
    const l = add('pend.', 9);
    l.centerAlignText();
    w.addSpacer();
    return;
  }
  const lock = family === 'accessoryRectangular';
  const rest = d.today.filter(
    (e) =>
      !e.done &&
      e.startAt &&
      (!d.next || Date.parse(e.startAt) > Date.parse(d.next.startAt)) &&
      e.time,
  );
  if (lock) {
    if (d.next) {
      const t = w.addText(`${d.next.time} ${d.next.title}`);
      t.font = Font.boldSystemFont(12);
      t.lineLimit = 1;
      if (d.next.startAt && new Date(d.next.startAt) > new Date())
        w.addDate(new Date(d.next.startAt)).applyRelativeStyle();
    } else add('Sin mas eventos', 12);
    if (rest[0]) add(ev(rest[0]), 11);
    return;
  }
  const max = { small: 4, medium: 5, large: 12 }[family] || 4;
  let lines = 0;
  const line = (text, size, gray) => {
    if (lines++ < max) add(text, size, gray);
  };
  d.today.forEach((e) => line(`${e.done ? '✓ ' : ''}${ev(e)}`, 13, e.done));
  if (!d.today.length) line('Nada para hoy', 13, true);
  const tm = d.tomorrow;
  if (tm && tm.first && !small) line(`Mañana: ${ev(tm.first)}`, 12, true);
  if (!small) d.reminders.forEach((r) => line(`En ${r.inDays} d: ${r.title}`, 12, true));
}

async function build(family, state) {
  const w = new ListWidget();
  w.refreshAfterDate = new Date(
    state.data && !state.error ? state.data.refreshAt : Date.now() + RETRY_MS,
  );
  fill(w, family, state);
  if (state.error && state.data) {
    const t = w.addText(state.error);
    t.font = Font.systemFont(10);
    t.lineLimit = 1;
  }
  // Marca de antiguedad: siempre en letra pequeña y gris para small/medium/large/rectangular.
  if (
    state.fetchedAt &&
    (family === 'small' ||
      family === 'medium' ||
      family === 'large' ||
      family === 'accessoryRectangular')
  ) {
    // addDate relativo: iOS lo actualiza solo aunque no relance el script
    const t = w.addDate(new Date(state.fetchedAt));
    t.applyRelativeStyle();
    t.font = Font.systemFont(9);
    t.textColor = Color.gray();
  }
  return w;
}

async function menu(state) {
  const a = new Alert();
  a.title = 'Organizador';
  ['Vista previa', 'Configurar token', 'Borrar token'].forEach((o) => a.addAction(o));
  a.addCancelAction('Cerrar');
  const i = await a.presentSheet();
  if (i === 0) {
    const fresh = await refresh(state);
    save(fresh);
    const w = await build('medium', fresh);
    await w.presentMedium();
  } else if (i === 1) {
    const p = new Alert();
    p.title = 'Token de la app';
    p.addSecureTextField('token');
    p.addAction('Guardar');
    p.addCancelAction('Cancelar');
    if ((await p.present()) === 0 && p.textFieldValue(0).trim()) {
      Keychain.set(KEY, p.textFieldValue(0).trim());
      save({ ...state, block: null, until: 0 });
    }
  } else if (i === 2) {
    if (Keychain.contains(KEY)) Keychain.remove(KEY);
    save({});
  }
}

const state = load();
if (config.runsInApp) {
  await menu(state);
} else {
  const fresh = await refresh(state);
  save(fresh);
  const family = config.widgetFamily || 'medium';
  Script.setWidget(await build(family, fresh));
}
Script.complete();
