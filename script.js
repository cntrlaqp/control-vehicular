// Configuración Supabase. Usa solo la clave Publishable en el navegador.
// Nunca pongas aquí una clave Secret o service_role.
const SUPABASE_URL = "https://ibezrcybtydxrhaeykcb.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_q6V-l0D3ktDR42MFeOkBcg_NQwX5XzX";
const configured = !SUPABASE_URL.includes("YOUR_PROJECT") && !SUPABASE_ANON_KEY.includes("YOUR_");
const db = configured ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

const byId = id => document.getElementById(id);
const labels = {
  disponible: "DISPONIBLE",
  emergencia: "EN EMERGENCIA",
  fuera: "FUERA DE SERVICIO",
  reserva: "EN RESERVA",
  no_reportado: "NO REPORTADO"
};

let profile = null;
let vehicles = [];
let companies = [];
let historyRows = [];
let selectedVehicle = null;
let realtime = null;
let refreshTimer = null;
const vehicleGroups = {
  ciudad: ["B-19", "B-77", "B-78", "B-140", "B-186", "B-187", "B-213", "B-233", "B-241", "B-YURA"],
  provincias: ["B-12", "B-35", "B-144", "B-205", "B-209"]
};
const vehicleGroupNames = {
  ciudad: "Unidades Vehiculares Arequipa Ciudad",
  provincias: "Unidades Vehiculares Provincias"
};

function message(text, error = false) {
  const el = byId("appMessage");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("error", error);
  el.hidden = !text;
}

function esc(s = "") {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));
}

function stateName(s) {
  return labels[s] || s || "NO REPORTADO";
}

function asDate(v) {
  return v ? new Date(v).toLocaleString("es-CO") : "—";
}

async function boot() {
  if (!configured) {
    byId("loginPanel").classList.remove("hidden");
    message(
      "Configura SUPABASE_URL y SUPABASE_ANON_KEY en script.js, y ejecuta supabase/schema.sql en tu proyecto.",
      true
    );
    return;
  }

  const { data: { session }, error } = await db.auth.getSession();

  if (error) {
    message("No se pudo verificar la sesión.", true);
  }

  if (session) {
    await enterApp();
  } else {
    byId("loginPanel").classList.remove("hidden");
  }

  // No recargar cuando Supabase informa que todavía no hay una sesión.
  db.auth.onAuthStateChange((event, session) => {
    if (session) {
      enterApp();
    } else if (event === "SIGNED_OUT") {
      profile = null;
      byId("application").classList.add("hidden");
      byId("loginPanel").classList.remove("hidden");
    }
  });
}

async function login(ev) {
  ev.preventDefault();
  message("");

  const { error } = await db.auth.signInWithPassword({
    email: byId("email").value.trim(),
    password: byId("password").value
  });

  if (error) {
    message(
      "No se pudo iniciar sesión. Revisa tus datos o contacta al administrador.",
      true
    );
  }
}

async function logout() {
  await db.auth.signOut();
}

async function enterApp() {
  byId("loginPanel").classList.add("hidden");
  byId("application").classList.remove("hidden");

  const { data: { user } } = await db.auth.getUser();

  const p = await db
    .from("perfiles")
    .select("id,nombre,rol,compania_id,activo,companias(codigo,nombre)")
    .eq("id", user.id)
    .single();

  if (p.error || !p.data?.activo) {
    message(
      "La cuenta no tiene un perfil activo. Solicita acceso al administrador.",
      true
    );
    await db.auth.signOut();
    return;
  }

  profile = p.data;
  byId("userInfo").textContent =
    `${profile.nombre} · ${profile.rol}` +
    `${profile.companias ? ` · ${profile.companias.codigo}` : ""}`;

  const central = profile.rol !== "COMPANIA";
  byId("modo").value = central ? "central" : "compania";
  byId("modo").disabled = !central;

  await refresh();
  subscribe();
  if (!refreshTimer) {
    setInterval(sendHeartbeat, 60000);
    refreshTimer = setInterval(() => {
      if (profile?.rol === "COMPANIA") refresh();
    }, 15000);
  }
  sendHeartbeat();
}

async function refresh() {
  const [c, v, h] = await Promise.all([
    db
      .from("companias")
      .select("id,codigo,nombre")
      .eq("activo", true)
      .order("codigo"),
    loadVehiclesForRole(),

    db
      .from("historial_estados")
      .select(
        "id,created_at,estado_anterior,estado_nuevo,observacion,vehiculos(codigo,companias(codigo)),perfiles(nombre)"
      )
      .order("created_at", { ascending: false })
      .limit(30)
  ]);

  const error = [c, v, h].find(x => x.error);

  if (error) {
    message("No se pudieron cargar los datos desde el servidor.", true);
    return;
  }

  companies = c.data || [];
  vehicles = v.data || [];
  historyRows = h.data || [];

  renderCompanies();
  renderCentral();
  renderCompany();
  renderSummary();
  renderHistory();

  byId("connectionText").textContent = "CONECTADO A SUPABASE";
}

async function loadVehiclesForRole() {
  const select = "id,codigo,compania_id,tipo_id,estado,observacion,updated_at,companias(codigo,nombre),tipos_vehiculo(nombre)";

  if (profile?.rol !== "COMPANIA") {
    return db
      .from("vehiculos")
      .select(select)
      .eq("activo", true)
      .order("codigo");
  }

  // El usuario de compañía recibe el detalle de su flota y solo estados básicos de las demás.
  const [ownResult, globalResult] = await Promise.all([
    db.from("vehiculos").select(select).eq("activo", true).order("codigo"),
    db.rpc("obtener_estado_global_vehiculos")
  ]);

  if (ownResult.error) return { data: null, error: ownResult.error };
  if (globalResult.error) return { data: null, error: globalResult.error };

  const ownById = new Map((ownResult.data || []).map(vehicle => [vehicle.id, vehicle]));
  const combined = (globalResult.data || []).map(row => {
    const ownVehicle = ownById.get(row.id);
    return ownVehicle || {
      id: row.id,
      codigo: row.codigo,
      compania_id: row.compania_id,
      tipo_id: row.tipo_id,
      estado: row.estado,
      observacion: "",
      updated_at: row.updated_at,
      companias: { codigo: row.codigo_compania, nombre: row.nombre_compania },
      tipos_vehiculo: { nombre: row.nombre_tipo }
    };
  });

  return { data: combined, error: null };
}

function renderCompanies() {
  // Las opciones son grupos fijos definidos en index.html.
  // Si el usuario de compañía pertenece a un solo grupo, seleccionarlo automáticamente.
  if (profile?.rol === "COMPANIA") {
    const ownCompany = companies.find(c => c.id === profile.compania_id);
    const group = Object.entries(vehicleGroups).find(([, codes]) =>
      codes.includes(ownCompany?.codigo)
    );
    if (group) byId("companiaSeleccionada").value = group[0];
  }
}

function filtered() {
  const group = byId("companiaSeleccionada").value;
  const codes = vehicleGroups[group] || [];

  return vehicles.filter(v =>
    codes.includes(v.companias?.codigo)
  );
}

function renderCentral() {
  const list = filtered();
  const tbody = byId("tablaCentralBody");

  if (!tbody) return;
  tbody.replaceChildren();

  const grouped = new Map();

  list.forEach(v => {
    const key = v.companias?.codigo || "—";
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(v);
  });

  grouped.forEach((rows, code) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td class="cia">${esc(code)}</td>`;

    rows.forEach(v => {
      const td = document.createElement("td");
      td.className = `vehicle-cell status-${v.estado}`;
      td.innerHTML =
        `<div>${esc(v.codigo)}</div><small>${stateName(v.estado)}</small>`;
      td.title =
        `${v.tipos_vehiculo?.nombre || ""} · ` +
        `${v.observacion || "Sin observaciones"}`;
      td.onclick = () => openVehicle(v);
      tr.append(td);
    });

    for (let i = rows.length; i < 7; i++) {
      tr.insertCell();
    }

    const last = document.createElement("td");
    last.className = "update-cell";
    last.textContent = asDate(
      rows.reduce((a, b) =>
        new Date(a.updated_at) > new Date(b.updated_at) ? a : b
      ).updated_at
    );

    tr.append(last);
    tbody.append(tr);
  });
}

function renderCompany() {
  const group = byId("companiaSeleccionada").value;
  const groupCodes = vehicleGroups[group] || [];
  const ownCompany = companies.find(c => c.id === profile?.compania_id);
  byId("nombreCompania").textContent = profile?.rol === "COMPANIA"
    ? `COMPAÑÍA ${ownCompany?.codigo || ""}`
    : (vehicleGroupNames[group] || "GRUPO DE UNIDADES");

  const mine = profile?.rol === "COMPANIA"
    ? vehicles.filter(v => v.compania_id === profile.compania_id)
    : vehicles.filter(v => groupCodes.includes(v.companias?.codigo));

  byId("vehiculosCompania").innerHTML = mine.map(v => `
    <article class="vehicle-card">
      <div class="vehicle-name">${esc(v.codigo)}</div>
      <div class="vehicle-type">${esc(v.tipos_vehiculo?.nombre || "")}</div>
      <div class="vehicle-status status-${v.estado}">${stateName(v.estado)}</div>
      <div class="vehicle-observation">
        ${esc(v.observacion || "Sin observaciones")}<br>
        <small>${asDate(v.updated_at)}</small>
      </div>
      <button class="change-button" data-id="${v.id}">ACTUALIZAR</button>
    </article>
  `).join("");

  document.querySelectorAll(".change-button[data-id]").forEach(b => {
    b.onclick = () => openVehicle(mine.find(v => v.id === b.dataset.id));
  });
}

function renderSummary() {
  const list = filtered();

  const counts = {
    total: list.length,
    disponible: 0,
    emergencia: 0,
    fuera: 0,
    reserva: 0,
    no_reportado: 0
  };

  list.forEach(v => {
    counts[v.estado] = (counts[v.estado] || 0) + 1;
  });

  const ids = {
    total: "totalVehiculos",
    disponible: "totalDisponibles",
    emergencia: "totalEmergencia",
    fuera: "totalFuera",
    reserva: "totalReserva"
  };

  for (const [key, id] of Object.entries(ids)) {
    byId(id).textContent = counts[key] || 0;
  }
}

function renderHistory() {
  byId("historial").innerHTML = historyRows.map(r => `
    <div class="history-item">
      <span class="history-time">${asDate(r.created_at)}</span>
      <strong>
        ${esc(r.vehiculos?.companias?.codigo || "")}
        ${esc(r.vehiculos?.codigo || "")}
      </strong>:
      ${stateName(r.estado_anterior)} →
      <strong>${stateName(r.estado_nuevo)}</strong> ·
      ${esc(r.perfiles?.nombre || "")}
      ${r.observacion ? ` — ${esc(r.observacion)}` : ""}
    </div>
  `).join("") || `<div class="history-item">No hay cambios registrados.</div>`;
}

function openVehicle(v) {
  if (!v) return;

  if (profile?.rol === "COMPANIA" &&
      v.compania_id !== profile.compania_id) {
    message("No tienes permiso para modificar ese vehículo.", true);
    return;
  }

  selectedVehicle = v;
  byId("modalVehiculo").textContent =
    `${v.companias?.codigo || ""} — ${v.codigo}`;
  byId("nuevoEstado").value = v.estado;
  byId("observacion").value = v.observacion || "";
  byId("modal").classList.remove("hidden");
}

function cerrarModal() {
  byId("modal").classList.add("hidden");
}

async function guardarCambio() {
  if (!selectedVehicle) return;

  const estado = byId("nuevoEstado").value;
  const observacion = byId("observacion").value.trim();

  byId("guardarCambio").disabled = true;

  const { error } = await db.rpc("actualizar_estado_vehiculo", {
    p_vehiculo_id: selectedVehicle.id,
    p_estado: estado,
    p_observacion: observacion
  });

  byId("guardarCambio").disabled = false;

  if (error) {
    message("No se pudo guardar el cambio. Verifica tu conexión y permisos.", true);
    return;
  }

  cerrarModal();
  message("Cambio guardado.");
  await refresh();
}

async function sendHeartbeat() {
  if (profile?.rol === "COMPANIA") {
    await db.rpc("registrar_contacto");
  }
}

function subscribe() {
  if (realtime) db.removeChannel(realtime);

  realtime = db
    .channel("operaciones")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "vehiculos" },
      refresh
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "historial_estados" },
      refresh
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "personal_disponible" },
      refresh
    )
    .subscribe(status => {
      byId("connectionText").textContent =
        status === "SUBSCRIBED" ? "EN VIVO · SUPABASE" : "RECONECTANDO…";
    });
}

byId("loginForm").addEventListener("submit", login);
byId("logout").addEventListener("click", logout);

byId("modo").addEventListener("change", () => {
  const companyMode = byId("modo").value === "compania";
  byId("vistaCentral").classList.toggle("hidden", companyMode);
  byId("vistaCompania").classList.toggle("hidden", !companyMode);
  renderCentral();
  renderCompany();
  renderSummary();
});

byId("companiaSeleccionada").addEventListener("change", () => {
  renderCentral();
  renderCompany();
  renderSummary();
});

byId("guardarCambio").addEventListener("click", guardarCambio);
byId("cancelarCambio").addEventListener("click", cerrarModal);

byId("fecha").textContent = new Date().toLocaleDateString("es-CO", {
  weekday: "long",
  year: "numeric",
  month: "long",
  day: "numeric"
});

setInterval(() => {
  byId("hora").textContent = new Date().toLocaleTimeString("es-CO");
}, 1000);

boot();
