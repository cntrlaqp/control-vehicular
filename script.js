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
let vehicleTypes = [];
let historyRows = [];
let personnelRows = [];
let selectedVehicle = null;
let realtime = null;
let refreshTimer = null;
let presenceLabelTimer = null;
let heartbeatInProgress = false;
let userManagementAccessCode = "";
let enteringApp = false;
let appSessionRenewTimer = null;
let appSessionRenewInProgress = false;
const vehicleGroups = {
  ciudad: ["B-19", "B-77", "B-78", "B-140", "B-186", "B-187", "B-213", "B-233", "B-241", "B-YURA"],
  provincias: ["B-12", "B-35", "B-144", "B-205", "B-209"]
};
const vehicleGroupNames = {
  ciudad: "Unidades Vehiculares Arequipa Ciudad",
  provincias: "Unidades Vehiculares Provincias"
};
// La conexión se considera caída si dejan de llegar tres heartbeats consecutivos.
const COMPANY_ONLINE_WINDOW_MS = 15 * 1000;
const COMPANY_HEARTBEAT_INTERVAL_MS = 5 * 1000;
const APP_SESSION_RENEW_INTERVAL_MS = 10 * 1000;

function compareCompaniesByGroupOrder(a, b, group) {
  const codes = vehicleGroups[group] || [];
  const aIndex = codes.indexOf(a.codigo);
  const bIndex = codes.indexOf(b.codigo);
  return (aIndex < 0 ? Number.MAX_SAFE_INTEGER : aIndex) -
    (bIndex < 0 ? Number.MAX_SAFE_INTEGER : bIndex);
}

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

  // Registrar primero el listener para no perder un cambio de sesión durante el arranque.
  db.auth.onAuthStateChange((event, session) => {
    if (session) {
      enterApp();
    } else if (event === "SIGNED_OUT") {
      stopAppSessionRenewal();
      profile = null;
      userManagementAccessCode = "";
      byId("application").classList.add("hidden");
      byId("loginPanel").classList.remove("hidden");
    }
  });

  const { data: { session }, error } = await db.auth.getSession();
  if (error) message("No se pudo verificar la sesión.", true);
  if (session) await enterApp();
  else byId("loginPanel").classList.remove("hidden");
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
  stopAppSessionRenewal();
  await db.rpc("liberar_sesion_app");
  await db.auth.signOut({ scope: "local" });
}

async function enterApp() {
  if (enteringApp || profile) return;
  enteringApp = true;
  byId("application").classList.add("hidden");
  byId("loginPanel").classList.remove("hidden");

  try {
    const { data: claimed, error: claimError } = await db.rpc("tomar_sesion_app");
    if (claimError) {
      await db.auth.signOut({ scope: "local" });
      message("No se pudo validar el acceso de sesión única. Verifica que se haya aplicado la migración de Supabase.", true);
      return;
    }
    if (claimed !== true) {
      await db.auth.signOut({ scope: "local" });
      message("Esta cuenta ya está activa en un equipo autorizado", true);
      return;
    }

    const { data: { user }, error: userError } = await db.auth.getUser();
    if (userError || !user) {
      await db.rpc("liberar_sesion_app");
      await db.auth.signOut({ scope: "local" });
      message("No se pudo verificar la cuenta. Inicia sesión nuevamente.", true);
      return;
    }

    const p = await db
      .from("perfiles")
      .select("id,nombre,rol,compania_id,activo,companias(codigo,nombre)")
      .eq("id", user.id)
      .single();

    if (p.error || !p.data?.activo) {
      await db.rpc("liberar_sesion_app");
      message("La cuenta no tiene un perfil activo. Solicita acceso al administrador.", true);
      await db.auth.signOut({ scope: "local" });
      return;
    }

    profile = p.data;
    byId("loginPanel").classList.add("hidden");
    byId("application").classList.remove("hidden");
    byId("addVehicle").classList.toggle("hidden", profile.rol !== "ADMINISTRADOR");
    byId("manageUsersButton").classList.toggle("hidden", profile.rol !== "ADMINISTRADOR");
    if (profile.rol === "COMPANIA") {
      const initialGroup = Object.entries(vehicleGroups).find(([, codes]) =>
        codes.includes(profile.companias?.codigo)
      );
      if (initialGroup) byId("companiaSeleccionada").value = initialGroup[0];
    }
    byId("userInfo").textContent =
      `${profile.nombre} · ${profile.rol}` +
      `${profile.companias ? ` · ${profile.companias.codigo}` : ""}`;

    const central = profile.rol !== "COMPANIA";
    byId("modo").value = central ? "central" : "compania";
    byId("modo").disabled = !central;
    byId("vistaCentral").classList.toggle("hidden", !central);
    byId("vistaCompania").classList.toggle("hidden", central);

    await refresh();
    subscribe();
    startAppSessionRenewal();
    if (!refreshTimer) {
      setInterval(sendHeartbeat, COMPANY_HEARTBEAT_INTERVAL_MS);
      refreshTimer = setInterval(() => {
        if (profile?.rol === "COMPANIA") refresh();
        else if (profile) refreshCompanyPresence();
      }, 10000);
    }
    if (!presenceLabelTimer) {
      presenceLabelTimer = setInterval(updateCompanyPresenceLabels, 1000);
    }
    sendHeartbeat();
  } finally {
    enteringApp = false;
  }
}

function stopAppSessionRenewal() {
  if (appSessionRenewTimer) clearInterval(appSessionRenewTimer);
  appSessionRenewTimer = null;
  appSessionRenewInProgress = false;
}

function startAppSessionRenewal() {
  if (appSessionRenewTimer) return;
  appSessionRenewTimer = setInterval(async () => {
    if (appSessionRenewInProgress || !profile) return;
    appSessionRenewInProgress = true;
    try {
      const { data: renewed, error } = await db.rpc("renovar_sesion_app");
      if (!error && renewed === false) {
        stopAppSessionRenewal();
        profile = null;
        await db.auth.signOut({ scope: "local" });
        message("La sesión de esta cuenta ya no está activa en este equipo. Vuelve a iniciar sesión.", true);
      }
    } finally {
      appSessionRenewInProgress = false;
    }
  }, APP_SESSION_RENEW_INTERVAL_MS);
}

async function refresh() {
  const [c, v, h, t, p] = await Promise.all([
    db
      .from("companias")
      .select("id,codigo,nombre,ultimo_contacto")
      .eq("activo", true)
      .order("codigo"),
    loadVehiclesForRole(),

    db
      .from("historial_estados")
      .select(
        "id,created_at,estado_anterior,estado_nuevo,observacion,vehiculos(codigo,companias(codigo)),perfiles(nombre)"
      )
      .order("created_at", { ascending: false })
      .limit(30),
    db
      .from("tipos_vehiculo")
      .select("id,nombre")
      .eq("activo", true)
      .order("nombre"),
    db
      .from("personal_disponible")
      .select("compania_id,pilotos,bomberos,updated_at,companias(codigo)")
  ]);

  const error = [c, v, h, t, p].find(x => x.error);

  if (error) {
    message("No se pudieron cargar los datos desde el servidor.", true);
    return;
  }

  companies = c.data || [];
  vehicleTypes = t.data || [];
  personnelRows = p.data || [];
  vehicles = v.data || [];
  historyRows = h.data || [];

  renderCompanies();
  renderAdminDropdowns();
  renderUserCompanyDropdown();
  renderCentral();
  renderCompany();
  renderSummary();
  renderHistory();
  renderPersonnel();

  byId("connectionText").textContent = "CONECTADO A SUPABASE";
}

function renderAdminDropdowns() {
  const companySelect = byId("adminVehicleCompany");
  const typeSelect = byId("adminVehicleType");
  if (!companySelect || !typeSelect) return;

  companySelect.replaceChildren();
  companies.forEach(company => {
    const option = document.createElement("option");
    option.value = company.id;
    option.textContent = `${company.codigo} · ${company.nombre}`;
    companySelect.append(option);
  });

  typeSelect.replaceChildren();
  vehicleTypes.forEach(type => {
    const option = document.createElement("option");
    option.value = type.id;
    option.textContent = type.nombre;
    typeSelect.append(option);
  });
}

function renderUserCompanyDropdown() {
  const select = byId("newUserCompany");
  if (!select) return;
  const previous = select.value;
  select.replaceChildren();
  companies.forEach(company => {
    const option = document.createElement("option");
    option.value = company.id;
    option.textContent = `${company.codigo} · ${company.nombre}`;
    select.append(option);
  });
  if (companies.some(company => company.id === previous)) select.value = previous;
}

function updateNewUserRoleFields() {
  const isCompany = byId("newUserRole").value === "COMPANIA";
  byId("newUserCompanyField").classList.toggle("hidden", !isCompany);
  byId("newUserCompany").required = isCompany;
}

async function createUser(event) {
  event.preventDefault();
  if (profile?.rol !== "ADMINISTRADOR") {
    message("Solo un administrador puede crear usuarios.", true);
    return;
  }

  const submit = byId("createUserSubmit");
  submit.disabled = true;
  submit.textContent = "CREANDO…";

  const payload = {
    action: "create",
    nombre: byId("newUserName").value.trim(),
    email: byId("newUserEmail").value.trim(),
    password: byId("newUserPassword").value,
    rol: byId("newUserRole").value,
    access_code: userManagementAccessCode,
    compania_id: byId("newUserRole").value === "COMPANIA"
      ? byId("newUserCompany").value
      : null
  };

  try {
    const { data, error } = await db.functions.invoke("admin-crear-usuario", {
      body: payload
    });

    if (error) {
      let detail = error.message || "No se pudo crear la cuenta.";
      try {
        const response = await error.context?.json();
        if (response?.error) detail = response.error;
      } catch { /* Usa el mensaje estándar si la respuesta no es JSON. */ }
      throw new Error(detail);
    }
    if (data?.error) throw new Error(data.error);

    byId("createUserForm").reset();
    updateNewUserRoleFields();
    message("Cuenta creada. Comparte la contraseña inicial con el usuario por un medio privado.");
  } catch (error) {
    message(error.message || "No se pudo crear la cuenta. Revisa la conexión e inténtalo de nuevo.", true);
  } finally {
    submit.disabled = false;
    submit.textContent = "CREAR CUENTA";
  }
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
  // Las opciones y la selección pertenecen al usuario; el refresh no debe cambiarlas.
}

function filtered() {
  const group = byId("companiaSeleccionada").value;
  const codes = vehicleGroups[group] || [];

  return vehicles.filter(v =>
    codes.includes(v.companias?.codigo)
  );
}

function emptyVehicleCell(companyId) {
  const cell = document.createElement("td");
  if (profile?.rol === "ADMINISTRADOR") {
    cell.className = "empty-vehicle-slot";
    cell.title = "Agregar un vehículo a esta compañía";
    cell.textContent = "+ Agregar";
    cell.onclick = () => openNewVehicle(companyId);
  }
  return cell;
}

function renderVehicleMatrix(body, companyRows) {
  body.replaceChildren();

  companyRows.forEach(({ company, vehicles: companyVehicles }) => {
    companyVehicles.sort((a, b) => a.codigo.localeCompare(b.codigo, "en"));
    const rowCount = Math.max(1, Math.ceil(companyVehicles.length / 7));

    for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
      const row = document.createElement("tr");
      const companyCell = document.createElement("td");
      companyCell.className = "cia";
      if (rowIndex === 0) {
        const online = company.ultimo_contacto &&
          Date.now() - new Date(company.ultimo_contacto).getTime() <= COMPANY_ONLINE_WINDOW_MS;
        companyCell.innerHTML = `
          <strong>${esc(company.codigo)}</strong>
          <small class="company-presence ${online ? "is-online" : "is-offline"}"
            data-company-id="${esc(company.id)}">
            ${online ? "En línea" : "Desconectado"}
          </small>
        `;
      }
      row.append(companyCell);

      for (let slot = 0; slot < 7; slot++) {
        const vehicle = companyVehicles[rowIndex * 7 + slot];
        if (!vehicle) {
          row.append(emptyVehicleCell(company.id));
          continue;
        }

        const cell = document.createElement("td");
        cell.className = `vehicle-cell status-${vehicle.estado}`;
        cell.innerHTML = `<div>${esc(vehicle.codigo)}</div><small>${stateName(vehicle.estado)}</small>`;
        cell.title = `${vehicle.tipos_vehiculo?.nombre || ""} · ${vehicle.observacion || "Sin observaciones"}`;
        const canEditVehicle = profile?.rol !== "COMPANIA" ||
          vehicle.compania_id === profile.compania_id;
        if (canEditVehicle) {
          cell.onclick = () => openVehicle(vehicle);
        } else {
          cell.classList.add("read-only-cell");
          cell.title = `${vehicle.tipos_vehiculo?.nombre || ""} · Solo lectura`;
        }
        row.append(cell);
      }

      const updateCell = document.createElement("td");
      updateCell.className = "update-cell";
      const mostRecent = companyVehicles.reduce((latest, vehicle) =>
        !latest || new Date(vehicle.updated_at) > new Date(latest.updated_at)
          ? vehicle
          : latest,
      null);
      updateCell.textContent = rowIndex === 0 && mostRecent
        ? asDate(mostRecent.updated_at)
        : "—";
      row.append(updateCell);
      body.append(row);
    }
  });
}

function updateCompanyPresenceLabels() {
  if (!profile || profile.rol === "COMPANIA") return;
  const now = Date.now();
  document.querySelectorAll(".company-presence[data-company-id]").forEach(label => {
    const company = companies.find(item => item.id === label.dataset.companyId);
    const lastContact = company?.ultimo_contacto
      ? new Date(company.ultimo_contacto).getTime()
      : NaN;
    const online = Number.isFinite(lastContact) && now - lastContact <= COMPANY_ONLINE_WINDOW_MS;
    label.textContent = online ? "En línea" : "Desconectado";
    label.classList.toggle("is-online", online);
    label.classList.toggle("is-offline", !online);
  });
}

async function refreshCompanyPresence() {
  const { data, error } = await db
    .from("companias")
    .select("id,ultimo_contacto")
    .eq("activo", true);

  if (error || !data) return;

  const contacts = new Map(data.map(company => [company.id, company.ultimo_contacto]));
  companies = companies.map(company => ({
    ...company,
    ultimo_contacto: contacts.has(company.id)
      ? contacts.get(company.id)
      : company.ultimo_contacto ?? null
  }));
  renderCentral();
  renderCompany();
}

function renderCentral() {
  const codes = new Set(vehicleGroups[byId("companiaSeleccionada").value] || []);
  const list = filtered();
  const companyRows = companies
    .filter(company => codes.has(company.codigo))
    .sort((a, b) => compareCompaniesByGroupOrder(a, b, byId("companiaSeleccionada").value))
    .map(company => ({
      company,
      vehicles: list.filter(vehicle => vehicle.compania_id === company.id)
    }));

  renderVehicleMatrix(byId("tablaCentralBody"), companyRows);
}

function renderCompany() {
  const group = byId("companiaSeleccionada").value;
  const groupCodes = vehicleGroups[group] || [];
  const ownCompany = companies.find(c => c.id === profile?.compania_id);
  byId("nombreCompania").textContent = profile?.rol === "COMPANIA"
    ? `UNIDADES DEL GRUPO · COMPAÑÍA ${ownCompany?.codigo || ""}`
    : (vehicleGroupNames[group] || "GRUPO DE UNIDADES");

  const visibleCompanies = companies.filter(c => groupCodes.includes(c.codigo));
  visibleCompanies.sort((a, b) => compareCompaniesByGroupOrder(a, b, group));

  const visibleVehicles = vehicles.filter(v => groupCodes.includes(v.companias?.codigo));

  const body = byId("vehiculosCompania");
  const companyRows = visibleCompanies.map(company => ({
    company,
    vehicles: visibleVehicles.filter(v => v.compania_id === company.id)
  }));
  renderVehicleMatrix(body, companyRows);

  const latestUpdate = visibleVehicles.reduce((latest, v) =>
    !latest || new Date(v.updated_at) > new Date(latest) ? v.updated_at : latest,
  null);
  byId("ultimaActualizacion").textContent = asDate(latestUpdate);
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

function csvCell(value) {
  let text = String(value ?? "");
  // Evita que textos ingresados por usuarios se interpreten como fórmulas en Excel.
  if (/^[\u0000-\u0020]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

async function exportHistoryToExcel() {
  const button = byId("exportHistoryButton");
  const fromValue = byId("historyDateFrom").value;
  const toValue = byId("historyDateTo").value;

  if (fromValue && toValue && fromValue > toValue) {
    message("La fecha inicial no puede ser posterior a la fecha final.", true);
    return;
  }

  button.disabled = true;
  button.textContent = "PREPARANDO…";
  message("");

  try {
    const pageSize = 500;
    const rows = [];
    let offset = 0;

    while (true) {
      let query = db
        .from("historial_estados")
        .select("created_at,estado_anterior,estado_nuevo,observacion,vehiculos(codigo,companias(codigo)),perfiles(nombre)")
        .order("created_at", { ascending: true })
        .range(offset, offset + pageSize - 1);

      if (fromValue) {
        query = query.gte("created_at", new Date(`${fromValue}T00:00:00`).toISOString());
      }
      if (toValue) {
        const exclusiveEnd = new Date(`${toValue}T00:00:00`);
        exclusiveEnd.setDate(exclusiveEnd.getDate() + 1);
        query = query.lt("created_at", exclusiveEnd.toISOString());
      }

      const { data, error } = await query;
      if (error) throw error;
      rows.push(...(data || []));
      if (!data || data.length < pageSize) break;
      offset += pageSize;
    }

    if (!rows.length) {
      message("No hay registros de historial para el período seleccionado.", true);
      return;
    }

    const headers = ["Fecha y hora", "Compañía", "Vehículo", "Estado anterior", "Estado nuevo", "Usuario", "Observación"];
    const csvRows = [headers, ...rows.map(row => [
      row.created_at ? new Date(row.created_at).toLocaleString("es-PE") : "",
      row.vehiculos?.companias?.codigo || "",
      row.vehiculos?.codigo || "",
      stateName(row.estado_anterior),
      stateName(row.estado_nuevo),
      row.perfiles?.nombre || "",
      row.observacion || ""
    ])];
    const csv = "\uFEFF" + csvRows.map(row => row.map(csvCell).join(";")).join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const period = fromValue && toValue
      ? `${fromValue}_a_${toValue}`
      : fromValue
        ? `desde_${fromValue}`
        : toValue
          ? `hasta_${toValue}`
          : "completo";
    link.href = url;
    link.download = `historial_vehicular_${period}.csv`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    message(`Exportación lista: ${rows.length} registros. Ábrela con Excel.`);
  } catch (error) {
    message(error.message || "No se pudo exportar el historial. Revisa la conexión e inténtalo de nuevo.", true);
  } finally {
    button.disabled = false;
    button.textContent = "EXPORTAR A EXCEL";
  }
}

function renderPersonnel() {
  const isCompany = profile?.rol === "COMPANIA";
  byId("personnelPanel").classList.toggle("hidden", !isCompany);
  byId("personnelOverview").classList.toggle("hidden", isCompany);

  if (isCompany) {
    const record = personnelRows.find(row => row.compania_id === profile.compania_id);
    const counts = record || { pilotos: 0, bomberos: 0 };
    byId("pilotos").textContent = counts.pilotos;
    byId("personal").textContent = counts.bomberos;
    byId("personalActualizado").textContent = asDate(record?.updated_at);
    return;
  }

  const selectedCodes = new Set(vehicleGroups[byId("companiaSeleccionada").value] || []);
  const body = byId("personnelOverviewBody");
  body.replaceChildren();
  const canEdit = profile?.rol === "ADMINISTRADOR";

  companies
    .filter(company => selectedCodes.has(company.codigo))
    .sort((a, b) => compareCompaniesByGroupOrder(a, b, byId("companiaSeleccionada").value))
    .forEach(company => {
      const record = personnelRows.find(row => row.compania_id === company.id);
      const counts = record || { pilotos: 0, bomberos: 0 };
      const total = counts.pilotos + counts.bomberos;
      const row = document.createElement("tr");
      row.innerHTML = `
        <td class="cia">${esc(company.codigo)}</td>
        <td>${personnelCountCell(company.id, "pilotos", counts.pilotos, canEdit)}</td>
        <td>${personnelCountCell(company.id, "bomberos", counts.bomberos, canEdit)}</td>
        <td><strong>${total}</strong></td>
        <td class="update-cell">${asDate(record?.updated_at)}</td>
        <td>${canEdit ? `<button class="save personnel-save" data-personnel-save="${company.id}">GUARDAR</button>` : "Solo lectura"}</td>
      `;
      body.append(row);
    });
}

function personnelCountCell(companyId, field, value, canEdit) {
  if (!canEdit) return String(value);
  return `<div class="personnel-inline">
    <button type="button" data-company="${companyId}" data-field="${field}" data-delta="-1">−</button>
    <input type="number" min="0" max="999" value="${value}" data-company="${companyId}" data-field="${field}">
    <button type="button" data-company="${companyId}" data-field="${field}" data-delta="1">+</button>
  </div>`;
}

async function changePersonnel(field, delta, companyId = profile?.compania_id) {
  if (profile?.rol !== "COMPANIA" && profile?.rol !== "ADMINISTRADOR") return;
  const oldRecord = personnelRows.find(row => row.compania_id === companyId);
  const counts = {
    pilotos: oldRecord?.pilotos || 0,
    bomberos: oldRecord?.bomberos || 0
  };
  counts[field] = Math.max(0, Math.min(999, counts[field] + delta));
  await savePersonnel(companyId, counts);
}

async function savePersonnel(companyId, counts) {
  const { error } = await db.rpc("actualizar_personal_disponible", {
    p_compania_id: companyId,
    p_pilotos: counts.pilotos,
    p_bomberos: counts.bomberos
  });
  if (error) {
    message("No se pudo guardar el personal disponible. Revisa tus permisos y conexión.", true);
    return;
  }
  message("Personal disponible actualizado.");
  await refresh();
}

function openVehicle(v) {
  if (!v) return;

  if (profile?.rol === "COMPANIA" &&
      v.compania_id !== profile.compania_id) {
    message("No tienes permiso para modificar ese vehículo.", true);
    return;
  }

  selectedVehicle = v;
  byId("modalTitle").textContent = profile?.rol === "ADMINISTRADOR"
    ? "EDITAR VEHÍCULO"
    : "CAMBIAR ESTADO";
  byId("modalVehiculo").textContent =
    `${v.companias?.codigo || ""} — ${v.codigo}`;
  byId("adminVehicleFields").classList.toggle(
    "hidden",
    profile?.rol !== "ADMINISTRADOR"
  );
  byId("desactivarVehiculo").classList.toggle(
    "hidden",
    profile?.rol !== "ADMINISTRADOR"
  );
  if (profile?.rol === "ADMINISTRADOR") {
    byId("adminVehicleCode").value = v.codigo;
    byId("adminVehicleCompany").value = v.compania_id;
    byId("adminVehicleType").value = v.tipo_id;
  }
  byId("nuevoEstado").value = v.estado;
  byId("observacion").value = v.observacion || "";
  byId("modal").classList.remove("hidden");
}

function openNewVehicle(companyId = null) {
  if (profile?.rol !== "ADMINISTRADOR") return;
  selectedVehicle = null;
  byId("modalTitle").textContent = "AGREGAR VEHÍCULO";
  byId("modalVehiculo").textContent = "Nueva unidad";
  byId("adminVehicleFields").classList.remove("hidden");
  byId("desactivarVehiculo").classList.add("hidden");
  byId("adminVehicleCode").value = "";
  if (companyId) byId("adminVehicleCompany").value = companyId;
  else if (companies.length) byId("adminVehicleCompany").value = companies[0].id;
  byId("adminVehicleType").selectedIndex = 0;
  byId("nuevoEstado").value = "no_reportado";
  byId("observacion").value = "";
  byId("modal").classList.remove("hidden");
  byId("adminVehicleCode").focus();
}

function cerrarModal() {
  byId("modal").classList.add("hidden");
}

async function guardarCambio() {
  const creatingVehicle = !selectedVehicle;
  const estado = byId("nuevoEstado").value;
  const observacion = byId("observacion").value.trim();
  byId("guardarCambio").disabled = true;

  let vehicleId = selectedVehicle?.id || null;
  let metadataChanged = false;

  if (profile?.rol === "ADMINISTRADOR") {
    const codigo = byId("adminVehicleCode").value.trim();
    const companiaId = byId("adminVehicleCompany").value;
    const tipoId = byId("adminVehicleType").value;
    metadataChanged = !selectedVehicle ||
      codigo !== selectedVehicle.codigo ||
      companiaId !== selectedVehicle.compania_id ||
      tipoId !== selectedVehicle.tipo_id;

    if (metadataChanged) {
      const { data, error } = await db.rpc("admin_guardar_vehiculo", {
        p_vehiculo_id: vehicleId,
        p_codigo: codigo,
        p_compania_id: companiaId,
        p_tipo_id: tipoId
      });
      if (error) {
        byId("guardarCambio").disabled = false;
        message("No se guardaron los datos del vehículo. Revisa el código, la compañía y el tipo.", true);
        return;
      }
      vehicleId = data;
      if (creatingVehicle) {
        selectedVehicle = {
          id: vehicleId,
          codigo,
          compania_id: companiaId,
          tipo_id: tipoId,
          estado: "no_reportado",
          observacion: ""
        };
      }
    }
  }

  const statusChanged = estado !== selectedVehicle?.estado ||
    observacion !== (selectedVehicle.observacion || "");

  if (statusChanged) {
    const { error } = await db.rpc("actualizar_estado_vehiculo", {
      p_vehiculo_id: vehicleId,
      p_estado: estado,
      p_observacion: observacion
    });

    if (error) {
      byId("guardarCambio").disabled = false;
      message("No se pudo guardar el estado. Verifica tu conexión y permisos.", true);
      return;
    }
  }

  byId("guardarCambio").disabled = false;
  cerrarModal();
  message(creatingVehicle ? "Vehículo agregado." : "Vehículo actualizado.");
  selectedVehicle = null;
  await refresh();
}

async function deactivateVehicle() {
  if (profile?.rol !== "ADMINISTRADOR" || !selectedVehicle) return;
  const confirmed = window.confirm(
    `¿Desactivar ${selectedVehicle.codigo}? Se ocultará de las vistas activas y conservará su historial.`
  );
  if (!confirmed) return;

  const { error } = await db.rpc("admin_desactivar_vehiculo", {
    p_vehiculo_id: selectedVehicle.id
  });
  if (error) {
    message("No se pudo desactivar el vehículo.", true);
    return;
  }
  cerrarModal();
  selectedVehicle = null;
  message("Vehículo desactivado; su historial se conserva.");
  await refresh();
}

async function sendHeartbeat() {
  if (profile?.rol !== "COMPANIA" || heartbeatInProgress) return;
  heartbeatInProgress = true;
  try {
    await db.rpc("registrar_contacto");
  } finally {
    heartbeatInProgress = false;
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
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "companias" },
      refreshCompanyPresence
    )
    .subscribe(status => {
      byId("connectionText").textContent =
        status === "SUBSCRIBED" ? "EN VIVO · SUPABASE" : "RECONECTANDO…";
    });
}

byId("loginForm").addEventListener("submit", login);
byId("logout").addEventListener("click", logout);
function closeUserGateModal() {
  byId("userGateModal").classList.add("hidden");
  byId("userGateForm").reset();
  byId("userGateError").hidden = true;
  byId("userGateError").textContent = "";
}

byId("manageUsersButton").addEventListener("click", () => {
  const panel = byId("userManagement");
  const opening = panel.classList.contains("hidden");
  if (!opening) {
    panel.classList.add("hidden");
    userManagementAccessCode = "";
    byId("manageUsersButton").setAttribute("aria-expanded", "false");
    return;
  }

  if (profile?.rol !== "ADMINISTRADOR") {
    message("Solo el administrador puede abrir esta opción.", true);
    return;
  }

  byId("userGateError").hidden = true;
  byId("userGateError").textContent = "";
  byId("userGateModal").classList.remove("hidden");
  byId("userGatePassword").focus();
});

byId("cancelUserGate").addEventListener("click", closeUserGateModal);
byId("userGateModal").addEventListener("click", event => {
  if (event.target === byId("userGateModal")) closeUserGateModal();
});
byId("userGateForm").addEventListener("submit", async event => {
  event.preventDefault();
  const enteredCode = byId("userGatePassword").value;
  const submit = byId("verifyUserGate");
  const errorBox = byId("userGateError");
  if (!enteredCode.trim()) return;

  submit.disabled = true;
  submit.textContent = "VALIDANDO…";
  errorBox.hidden = true;
  try {
    const { data, error } = await db.functions.invoke("admin-crear-usuario", {
      body: { action: "verify", access_code: enteredCode }
    });
    if (error) {
      let detail = error.message || "No se pudo validar la clave.";
      try {
        const response = await error.context?.json();
        if (response?.error) detail = response.error;
      } catch { /* Conserva el mensaje estándar. */ }
      throw new Error(detail);
    }
    if (data?.error) throw new Error(data.error);

    userManagementAccessCode = enteredCode;
    closeUserGateModal();
    byId("userManagement").classList.remove("hidden");
    byId("manageUsersButton").setAttribute("aria-expanded", "true");
    message("Acceso autorizado. Al cerrar el panel, tendrás que ingresar la clave otra vez.");
    byId("newUserName").focus();
  } catch (error) {
    userManagementAccessCode = "";
    errorBox.textContent = error.message || "Clave incorrecta o función no configurada.";
    errorBox.hidden = false;
    byId("userGatePassword").select();
  } finally {
    submit.disabled = false;
    submit.textContent = "CONTINUAR";
  }
});
byId("newUserRole").addEventListener("change", updateNewUserRoleFields);
byId("createUserForm").addEventListener("submit", createUser);

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
  renderPersonnel();
});

byId("personnelGrid").addEventListener("click", event => {
  const button = event.target.closest("button[data-field]");
  if (!button) return;
  changePersonnel(button.dataset.field, Number(button.dataset.delta));
});

byId("personnelOverviewBody").addEventListener("click", event => {
  const stepButton = event.target.closest("button[data-company][data-field][data-delta]");
  if (stepButton) {
    changePersonnel(
      stepButton.dataset.field,
      Number(stepButton.dataset.delta),
      stepButton.dataset.company
    );
    return;
  }

  const saveButton = event.target.closest("button[data-personnel-save]");
  if (!saveButton) return;
  const row = saveButton.closest("tr");
  const companyId = saveButton.dataset.personnelSave;
  const counts = {};
  row.querySelectorAll("input[data-field]").forEach(input => {
    counts[input.dataset.field] = Math.max(0, Math.min(999, Number(input.value) || 0));
  });
  savePersonnel(companyId, counts);
});

byId("exportHistoryButton").addEventListener("click", exportHistoryToExcel);

byId("guardarCambio").addEventListener("click", guardarCambio);
byId("cancelarCambio").addEventListener("click", cerrarModal);
byId("addVehicle").addEventListener("click", () => openNewVehicle());
byId("desactivarVehiculo").addEventListener("click", deactivateVehicle);

updateNewUserRoleFields();

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
