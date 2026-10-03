// Esta vista solo consulta la funcion publica de lectura.
// La publishable key puede ir en el navegador; nunca uses una secret/service_role.
const PUBLIC_SUPABASE_URL = "https://ibezrcybtydxrhaeykcb.supabase.co";
const PUBLIC_SUPABASE_KEY = "sb_publishable_q6V-l0D3ktDR42MFeOkBcg_NQwX5XzX";
const publicDb = window.supabase.createClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_KEY);

const stateLabels = {
  disponible: "DISPONIBLE",
  emergencia: "EN EMERGENCIA",
  fuera: "FUERA DE SERVICIO",
  reserva: "EN RESERVA",
  no_reportado: "NO REPORTADO"
};

const companyOrder = [
  "B-19", "B-77", "B-78", "B-140", "B-186", "B-187", "B-213", "B-233", "B-241", "B-YURA",
  "B-12", "B-35", "B-144", "B-205", "B-209"
];

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

function statusLabel(value) {
  return stateLabels[value] || "NO REPORTADO";
}

function formatDate(value) {
  return value ? new Date(value).toLocaleString("es-PE") : "—";
}

function renderTable(companies) {
  const sortedCompanies = [...companies].sort((a, b) => {
    const aIndex = companyOrder.indexOf(a.codigo_compania);
    const bIndex = companyOrder.indexOf(b.codigo_compania);
    return (aIndex < 0 ? Number.MAX_SAFE_INTEGER : aIndex) -
      (bIndex < 0 ? Number.MAX_SAFE_INTEGER : bIndex);
  });
  const maxVehicles = Math.max(1, ...sortedCompanies.map(company => (company.vehiculos || []).length));
  const head = document.getElementById("publicTableHead");
  const body = document.getElementById("publicTableBody");

  head.innerHTML = `<tr>
    <th scope="col">CIA</th>
    ${Array.from({ length: maxVehicles }, (_, index) => `<th scope="col">VEHÍCULO ${index + 1}</th>`).join("")}
    <th scope="col">ACTUALIZACIÓN</th>
  </tr>`;

  body.innerHTML = sortedCompanies.map(company => {
    const vehicles = company.vehiculos || [];
    const latest = vehicles.reduce((value, vehicle) => {
      if (!vehicle.actualizado_en) return value;
      return !value || new Date(vehicle.actualizado_en) > new Date(value)
        ? vehicle.actualizado_en
        : value;
    }, null);
    const vehicleCells = Array.from({ length: maxVehicles }, (_, index) => {
      const vehicle = vehicles[index];
      if (!vehicle) return `<td class="blank" aria-label="Sin vehículo"></td>`;
      const state = stateLabels[vehicle.estado] ? vehicle.estado : "no_reportado";
      const title = vehicle.tipo ? ` title="${escapeHtml(vehicle.tipo)}"` : "";
      return `<td class="vehicle status-${state}"${title}>
        <strong>${escapeHtml(vehicle.codigo || "")}</strong>
        <small>${statusLabel(vehicle.estado)}</small>
      </td>`;
    }).join("");
    return `<tr>
      <td class="company">${escapeHtml(company.codigo_compania || "")}</td>
      ${vehicleCells}
      <td class="updated">${escapeHtml(formatDate(latest))}</td>
    </tr>`;
  }).join("");
}

async function loadPublicStatus() {
  try {
    const { data, error } = await publicDb.rpc("estado_publico_vehiculos");
    if (error) throw error;
    if (!Array.isArray(data)) throw new Error("El endpoint devolvió un formato inesperado.");

    renderTable(data);
  } catch (error) {
    const head = document.getElementById("publicTableHead");
    const body = document.getElementById("publicTableBody");
    head.replaceChildren();
    body.innerHTML = `<tr><td class="table-message error" colspan="9">No se pudo cargar el estado de vehículos. Revisa la conexión e inténtalo nuevamente.</td></tr>`;
  }
}

document.getElementById("publicTableBody").innerHTML =
  `<tr><td class="table-message" colspan="9">Cargando estado de vehículos…</td></tr>`;
loadPublicStatus();
setInterval(loadPublicStatus, 60000);
