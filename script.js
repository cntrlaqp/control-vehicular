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
  if (!refreshTimer) {
    setInterval(sendHeartbeat, 60000);
    refreshTimer = setInterval(() => {
      if (profile?.rol === "COMPANIA") refresh();
    }, 15000);
  }
  sendHeartbeat();
}

async function refresh() {
  const [c, v, h, t, p] = await Promise.all([
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
    nombre: byId("newUserName").value.trim(),
    email: byId("newUserEmail").value.trim(),
    password: byId("newUserPassword").value,
    rol: byId("newUserRole").value,
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
      companyCell.textContent = rowIndex === 0 ? company.codigo : "";
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

function renderCentral() {
  const codes = new Set(vehicleGroups[byId("companiaSeleccionada").value] || []);
  const list = filtered();
  const companyRows = companies
    .filter(company => codes.has(company.codigo))
    .sort((a, b) => a.codigo.localeCompare(b.codigo, "en"))
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
  visibleCompanies.sort((a, b) => a.codigo.localeCompare(b.codigo, "en"));

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
    .sort((a, b) => a.codigo.localeCompare(b.codigo, "en"))
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
byId("manageUsersButton").addEventListener("click", () => {
  const panel = byId("userManagement");
  const opening = panel.classList.contains("hidden");
  panel.classList.toggle("hidden", !opening);
  byId("manageUsersButton").setAttribute("aria-expanded", String(opening));
  if (opening) byId("newUserName").focus();
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
