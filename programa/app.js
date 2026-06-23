let data = {
  clientes: [],
  ventas: [],
  pagos: [],
  configuracion: {
    nombre: "MA One",
    telefono: "",
    moneda: "USD",
    logoUrl: "",
    logoPath: "",
    tema: "light",
    colorPrimario: "#2563eb",
    densidad: "comfortable",
    bordes: "rounded"
  }
};
const $ = (id) => document.getElementById(id);
let db = null;
let currentUser = null;
let currentBusinessOwner = null;
let currentRole = "propietario";
let isPlatformAdmin = false;
let ownBusinessOwner = null;
let authMode = "login";
let editando = null;
let whatsappPendiente = null;
let quitarLogoSolicitado = false;
let authListenerReady = false;
const LOGO_PREDETERMINADO = "assets/ma-one-logo-web.png";
const SUPABASE_TIMEOUT_MS = 15000;

function configuracionValida() {
  try {
    const url = new URL(SUPABASE_URL);
    return url.protocol === "https:"
      && url.hostname.endsWith(".supabase.co")
      && SUPABASE_ANON_KEY.startsWith("sb_publishable_");
  } catch {
    return false;
  }
}

function escaparHTML(valor) {
  return String(valor ?? "").replace(/[&<>"']/g, caracter => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[caracter]);
}

function mensajeErrorSupabase(error, contexto = "") {
  const codigo = error?.code || "";
  const mensaje = String(error?.message || "").toLowerCase();

  if (codigo === "PGRST205" || codigo === "42P01") {
    return `Falta una tabla de Supabase${contexto ? ` (${contexto})` : ""}.`;
  }
  if (codigo === "42501" || mensaje.includes("permission denied") || mensaje.includes("row-level security")) {
    return `Permiso denegado en ${contexto || "Supabase"}. Revisa RLS y el usuario conectado.`;
  }
  if (mensaje.includes("jwt") || mensaje.includes("refresh token") || mensaje.includes("session")) {
    return "La sesión venció. Inicia sesión nuevamente.";
  }
  if (mensaje.includes("failed to fetch") || mensaje.includes("network") || mensaje.includes("timeout")) {
    return "No hay comunicación con Supabase. Revisa Internet y vuelve a intentar.";
  }
  return `Supabase rechazó la operación${contexto ? ` en ${contexto}` : ""}${codigo ? ` (${codigo})` : ""}.`;
}

async function conTimeout(promesa, ms = SUPABASE_TIMEOUT_MS) {
  let temporizador;
  const limite = new Promise((_, reject) => {
    temporizador = setTimeout(() => reject(new Error("timeout")), ms);
  });
  try {
    return await Promise.race([promesa, limite]);
  } finally {
    clearTimeout(temporizador);
  }
}

async function cargar() {
  let resultados;
  try {
    resultados = await conTimeout(Promise.all([
      db.from("clientes").select("*").eq("owner_id", currentBusinessOwner).order("nombre", { ascending: true }),
      db.from("ventas").select("*").eq("owner_id", currentBusinessOwner).order("fecha", { ascending: false }),
      db.from("pagos").select("*").eq("owner_id", currentBusinessOwner).order("fecha", { ascending: false }),
      db.from("configuracion").select("*").eq("owner_id", currentBusinessOwner).maybeSingle()
    ]));
  } catch (error) {
    console.error("Error de red al cargar Supabase:", error);
    toast(mensajeErrorSupabase(error), "error");
    return false;
  }
  const [cRes, vRes, pRes, confRes] = resultados;

  const erroresPrincipales = [
    ["clientes", cRes.error],
    ["ventas", vRes.error],
    ["pagos", pRes.error]
  ].filter(([, error]) => error);

  if (erroresPrincipales.length > 0) {
    erroresPrincipales.forEach(([tabla, error]) => console.error(`Error en ${tabla}:`, error));
    const [tabla, error] = erroresPrincipales[0];
    toast(mensajeErrorSupabase(error, tabla), "error");
    return false;
  }

  if (confRes.error) {
    console.warn("No se pudo cargar la configuración del negocio:", confRes.error);
    data.configuracion = {
      nombre: "MA One",
      telefono: "",
      moneda: "USD",
      logoUrl: "",
      logoPath: "",
      ...cargarAparienciaLocal()
    };
    toast("Datos cargados. Falta ejecutar la actualización SQL de configuración.", "error");
  }

  data.clientes = (cRes.data || []).map(c => ({
    id: c.id,
    nombre: c.nombre,
    telefono: c.telefono || ""
  }));

  data.ventas = (vRes.data || []).map(v => ({
    id: v.id,
    clienteId: v.cliente_id,
    fecha: v.fecha,
    total: Number(v.total),
    abonoInicial: Number(v.abono_inicial || 0),
    observaciones: v.observaciones || ""
  }));

  data.pagos = (pRes.data || []).map(p => ({
    id: p.id,
    ventaId: p.venta_id,
    fecha: p.fecha,
    monto: Number(p.monto),
    observacion: p.observacion || ""
  }));

  if (!confRes.error && confRes.data) {
    const aparienciaLocal = cargarAparienciaLocal();
    const logoGuardado = normalizarLogoGuardado(confRes.data.logo_url || "");
    const logoVisible = await resolverLogoGuardado(logoGuardado);
    data.configuracion = {
      nombre: ["Ventas", "Ventas & Deudas"].includes(confRes.data.nombre)
        ? "MA One"
        : (confRes.data.nombre || "MA One"),
      telefono: confRes.data.telefono || "",
      moneda: confRes.data.moneda || "USD",
      logoUrl: logoVisible,
      logoPath: logoGuardado,
      tema: confRes.data.tema || aparienciaLocal.tema,
      colorPrimario: confRes.data.color_primario || aparienciaLocal.colorPrimario,
      densidad: confRes.data.densidad || aparienciaLocal.densidad,
      bordes: confRes.data.bordes || aparienciaLocal.bordes
    };
  }

  aplicarConfiguracion();

  return true;
}

function dinero(valor) {
  return Number(valor || 0).toLocaleString("es", {
    style: "currency",
    currency: data.configuracion.moneda || "USD"
  });
}

function aplicarConfiguracion() {
  const config = data.configuracion;
  $("brandName").textContent = config.nombre;
  document.title = config.nombre;
  $("configNombre").value = config.nombre;
  $("configTelefono").value = config.telefono;
  $("configMoneda").value = config.moneda;
  $("configTema").value = config.tema;
  $("configColor").value = config.colorPrimario;
  $("configColorValue").textContent = config.colorPrimario;
  $("configDensidad").value = config.densidad;
  $("configBordes").value = config.bordes;
  aplicarApariencia(config);

  const logo = $("brandLogo");
  if (!config.logoUrl) {
    logo.src = LOGO_PREDETERMINADO;
    logo.hidden = false;
  } else {
    try {
      const url = new URL(config.logoUrl);
      logo.src = url.href;
      logo.hidden = !["http:", "https:"].includes(url.protocol);
    } catch {
      logo.src = LOGO_PREDETERMINADO;
      logo.hidden = false;
    }
  }
  $("configLogoPreview").src = logo.src;
}

async function subirLogoNegocio(archivo) {
  if (!archivo) return data.configuracion.logoPath || "";
  const tiposPermitidos = ["image/png", "image/jpeg", "image/webp"];
  if (!tiposPermitidos.includes(archivo.type)) {
    throw new Error("El logo debe ser PNG, JPG o WebP.");
  }
  if (archivo.size > 2 * 1024 * 1024) {
    throw new Error("El logo no puede superar 2 MB.");
  }

  const extension = archivo.type === "image/png"
    ? "png"
    : archivo.type === "image/webp" ? "webp" : "jpg";
  const ruta = `${currentBusinessOwner}/logo.${extension}`;
  const { error } = await db.storage.from("logos-negocio").upload(ruta, archivo, {
    cacheControl: "3600",
    contentType: archivo.type,
    upsert: true
  });
  if (error) throw error;

  return `storage:${ruta}`;
}

async function resolverLogoGuardado(valor) {
  if (!valor) return "";
  if (!valor.startsWith("storage:")) return valor;
  const ruta = valor.slice("storage:".length);
  const { data: urlData, error } = await db.storage
    .from("logos-negocio")
    .createSignedUrl(ruta, 3600);
  if (error) {
    console.error("No se pudo abrir el logo privado:", error);
    return "";
  }
  return urlData.signedUrl;
}

function normalizarLogoGuardado(valor) {
  if (!valor || valor.startsWith("storage:")) return valor;
  const marcador = "/storage/v1/object/public/logos-negocio/";
  const posicion = valor.indexOf(marcador);
  if (posicion === -1) return valor;
  const rutaConQuery = valor.slice(posicion + marcador.length);
  return `storage:${decodeURIComponent(rutaConQuery.split("?")[0])}`;
}

$("configLogoArchivo").addEventListener("change", event => {
  const archivo = event.target.files[0];
  if (!archivo) return;
  if (!["image/png", "image/jpeg", "image/webp"].includes(archivo.type)) {
    event.target.value = "";
    return toast("Selecciona una imagen PNG, JPG o WebP.", "error");
  }
  if (archivo.size > 2 * 1024 * 1024) {
    event.target.value = "";
    return toast("El logo no puede superar 2 MB.", "error");
  }
  quitarLogoSolicitado = false;
  const urlTemporal = URL.createObjectURL(archivo);
  $("configLogoPreview").src = urlTemporal;
  $("configLogoPreview").onload = () => URL.revokeObjectURL(urlTemporal);
});

$("quitarLogo").addEventListener("click", () => {
  quitarLogoSolicitado = true;
  $("configLogoArchivo").value = "";
  $("configLogoPreview").src = LOGO_PREDETERMINADO;
});

function colorValido(color) {
  return /^#[0-9a-f]{6}$/i.test(color);
}

function ajustarColor(hex, cantidad) {
  const numero = parseInt(hex.slice(1), 16);
  const r = Math.max(0, Math.min(255, (numero >> 16) + cantidad));
  const g = Math.max(0, Math.min(255, ((numero >> 8) & 255) + cantidad));
  const b = Math.max(0, Math.min(255, (numero & 255) + cantidad));
  return `#${[r, g, b].map(valor => valor.toString(16).padStart(2, "0")).join("")}`;
}

function cargarAparienciaLocal() {
  const predeterminada = {
    tema: "light",
    colorPrimario: "#2563eb",
    densidad: "comfortable",
    bordes: "rounded"
  };
  try {
    return { ...predeterminada, ...JSON.parse(localStorage.getItem("aparienciaSistema") || "{}") };
  } catch {
    return predeterminada;
  }
}

function aplicarApariencia(config) {
  const temaElegido = ["light", "dark", "system"].includes(config.tema) ? config.tema : "light";
  const temaReal = temaElegido === "system"
    ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    : temaElegido;
  const color = colorValido(config.colorPrimario) ? config.colorPrimario : "#2563eb";

  document.documentElement.dataset.theme = temaReal;
  document.documentElement.dataset.density = config.densidad === "compact" ? "compact" : "comfortable";
  document.documentElement.dataset.radius = config.bordes === "square" ? "square" : "rounded";
  document.documentElement.style.setProperty("--blue", color);
  document.documentElement.style.setProperty("--blue-dark", ajustarColor(color, -28));
  document.documentElement.style.setProperty("--blue-light",
    temaReal === "dark"
      ? `color-mix(in srgb, ${color} 18%, #111827)`
      : `color-mix(in srgb, ${color} 10%, white)`);

  $("themeIcon").textContent = temaReal === "dark" ? "☀" : "☾";
  $("btnThemeToggle").setAttribute("aria-label", temaReal === "dark" ? "Activar modo claro" : "Activar modo noche");
  localStorage.setItem("aparienciaSistema", JSON.stringify({
    tema: temaElegido,
    colorPrimario: color,
    densidad: config.densidad,
    bordes: config.bordes
  }));
}

function leerAparienciaFormulario() {
  return {
    tema: $("configTema").value,
    colorPrimario: $("configColor").value,
    densidad: $("configDensidad").value,
    bordes: $("configBordes").value
  };
}

function fechaActual() {
  const ahora = new Date();
  const offsetLocal = ahora.getTimezoneOffset() * 60000;
  return new Date(ahora.getTime() - offsetLocal).toISOString().slice(0, 10);
}
function obtenerCliente(id) { return data.clientes.find(c => c.id === id); }
function obtenerVenta(id) { return data.ventas.find(v => v.id === id); }
function iniciales(nombre) { return nombre.split(" ").slice(0, 2).map(p => p[0]).join("").toUpperCase(); }
function pagosDeVenta(ventaId) { return data.pagos.filter(p => p.ventaId === ventaId).reduce((s, p) => s + Number(p.monto), 0); }
function totalAbonadoVenta(venta) { return Number(venta.abonoInicial || 0) + pagosDeVenta(venta.id); }
function saldoVenta(venta) { return Math.max(0, Number(venta.total) - totalAbonadoVenta(venta)); }
function ventasDeCliente(clienteId) { return data.ventas.filter(v => v.clienteId === clienteId); }

function resumenCliente(clienteId) {
  const ventas = ventasDeCliente(clienteId);
  const vendido = ventas.reduce((s, v) => s + Number(v.total), 0);
  const abonado = ventas.reduce((s, v) => s + totalAbonadoVenta(v), 0);
  return { vendido, abonado, deuda: Math.max(0, vendido - abonado) };
}

let toastTimer;
function toast(msg, tipo = "") {
  const el = $("toast");
  if (!el) return alert(msg);
  el.textContent = msg;
  el.className = "toast show " + tipo;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2800);
}

function actualizarSelects() {
  const ventaCliente = $("ventaCliente");
  const pagoVenta = $("pagoVenta");

  ventaCliente.innerHTML = data.clientes.length === 0
    ? `<option value="">Primero agrega un cliente</option>`
    : data.clientes.map(c => `<option value="${escaparHTML(c.id)}">${escaparHTML(c.nombre)}</option>`).join("");

  const pendientes = data.ventas.filter(v => saldoVenta(v) > 0);
  pagoVenta.innerHTML = pendientes.length === 0
    ? `<option value="">No hay cuentas pendientes</option>`
    : pendientes.map(v => {
      const c = obtenerCliente(v.clienteId);
      return `<option value="${escaparHTML(v.id)}">${escaparHTML(c ? c.nombre : "Cliente eliminado")} — saldo ${dinero(saldoVenta(v))}</option>`;
    }).join("");

  actualizarInfoSaldo();
}

function actualizarInfoSaldo() {
  const info = $("pagoSaldoInfo");
  if (!info) return;
  const venta = obtenerVenta($("pagoVenta").value);
  info.innerHTML = venta ? `Saldo pendiente: <strong>${dinero(saldoVenta(venta))}</strong>` : "";
}

function renderDashboard() {
  const totalVendido = data.ventas.reduce((s, v) => s + Number(v.total), 0);
  const totalAbonado = data.ventas.reduce((s, v) => s + totalAbonadoVenta(v), 0);
  const totalDeuda = Math.max(0, totalVendido - totalAbonado);
  const conDeuda = data.clientes.filter(c => resumenCliente(c.id).deuda > 0).length;
  const cuentasAbiertas = data.ventas.filter(v => saldoVenta(v) > 0).length;

  $("totalVendido").textContent = dinero(totalVendido);
  $("totalAbonado").textContent = dinero(totalAbonado);
  $("totalDeuda").textContent = dinero(totalDeuda);
  $("totalClientes").textContent = data.clientes.length;
  $("statVentas").textContent = data.ventas.length + " ventas";
  $("statPagos").textContent = data.pagos.length + " pagos";
  $("statPendientes").textContent = cuentasAbiertas + " cuentas abiertas";
  $("statConDeuda").textContent = conDeuda + " con deuda";

  const tbody = $("tablaResumen");
  const deudores = data.clientes.filter(c => resumenCliente(c.id).deuda > 0);
  $("badgeDeuda").textContent = deudores.length;

  if (deudores.length === 0) {
    tbody.innerHTML = `<tr class="td-empty"><td colspan="5">Sin cuentas con deuda. ¡Todo al día!</td></tr>`;
    return;
  }

  tbody.innerHTML = deudores.map(c => {
    const r = resumenCliente(c.id);
    const whatsapp = c.telefono
      ? `<button class="btn-sm whatsapp" data-action="whatsapp" data-id="${escaparHTML(c.id)}">WhatsApp</button>`
      : "";
    return `<tr><td><strong>${escaparHTML(c.nombre)}</strong></td><td>${dinero(r.vendido)}</td><td>${dinero(r.abonado)}</td><td><span class="chip chip-danger">${dinero(r.deuda)}</span></td><td><div class="btn-group"><button class="btn-sm" data-action="ver-cliente" data-id="${escaparHTML(c.id)}">Ver</button>${whatsapp}</div></td></tr>`;
  }).join("");
}

function renderClientes() {
  const filtro = ($("buscador").value || "").toLowerCase().trim();
  const tbody = $("tablaClientes");
  const lista = data.clientes.filter(c => c.nombre.toLowerCase().includes(filtro) || String(c.telefono || "").toLowerCase().includes(filtro));
  $("badgeClientes").textContent = data.clientes.length;

  if (lista.length === 0) {
    tbody.innerHTML = `<tr class="td-empty"><td colspan="6">No hay clientes registrados.</td></tr>`;
    return;
  }

  tbody.innerHTML = lista.map(c => {
    const r = resumenCliente(c.id);
    const chip = r.deuda > 0 ? "chip-danger" : "chip-success";
    const telefono = c.telefono ? escaparHTML(c.telefono) : "<span style='color:var(--gray-400)'>—</span>";
    const whatsapp = c.telefono && r.deuda > 0
      ? `<button class="btn-sm whatsapp" data-action="whatsapp" data-id="${escaparHTML(c.id)}">WhatsApp</button>`
      : "";
    return `<tr><td><strong>${escaparHTML(c.nombre)}</strong></td><td>${telefono}</td><td>${dinero(r.vendido)}</td><td>${dinero(r.abonado)}</td><td><span class="chip ${chip}">${dinero(r.deuda)}</span></td><td><div class="btn-group"><button class="btn-sm" data-action="ver-cliente" data-id="${escaparHTML(c.id)}">Ver</button><button class="btn-sm" data-action="editar-cliente" data-id="${escaparHTML(c.id)}">Editar</button>${whatsapp}<button class="btn-sm danger" data-action="eliminar-cliente" data-id="${escaparHTML(c.id)}">Eliminar</button></div></td></tr>`;
  }).join("");
}

function renderVentas() {
  const tbody = $("tablaVentas");
  let lista = [...data.ventas].sort((a, b) => b.fecha.localeCompare(a.fecha));
  const filtroEstado = $("filtroEstadoVenta").value;
  if (filtroEstado === "pendiente") lista = lista.filter(v => saldoVenta(v) > 0);
  if (filtroEstado === "pagada") lista = lista.filter(v => saldoVenta(v) === 0);

  if (lista.length === 0) {
    tbody.innerHTML = `<tr class="td-empty"><td colspan="7">No hay ventas que mostrar.</td></tr>`;
    return;
  }

  tbody.innerHTML = lista.map(v => {
    const c = obtenerCliente(v.clienteId);
    const saldo = saldoVenta(v);
    const chip = saldo > 0 ? "chip-danger" : "chip-success";
    const nombreCliente = c ? escaparHTML(c.nombre) : "<em style='color:var(--gray-400)'>Eliminado</em>";
    const observaciones = v.observaciones ? escaparHTML(v.observaciones) : "<span style='color:var(--gray-400)'>—</span>";
    return `<tr><td>${escaparHTML(v.fecha)}</td><td>${nombreCliente}</td><td>${dinero(v.total)}</td><td>${dinero(totalAbonadoVenta(v))}</td><td><span class="chip ${chip}">${saldo > 0 ? dinero(saldo) : "Pagada"}</span></td><td style="max-width:180px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${observaciones}</td><td><div class="btn-group"><button class="btn-sm" data-action="editar-venta" data-id="${escaparHTML(v.id)}">Editar</button><button class="btn-sm danger" data-action="eliminar-venta" data-id="${escaparHTML(v.id)}">Eliminar</button></div></td></tr>`;
  }).join("");
}

function renderPagos() {
  const tbody = $("tablaPagos");
  const lista = [...data.pagos].sort((a, b) => b.fecha.localeCompare(a.fecha));
  $("badgePagos").textContent = lista.length;

  if (lista.length === 0) {
    tbody.innerHTML = `<tr class="td-empty"><td colspan="5">No hay pagos registrados.</td></tr>`;
    return;
  }

  tbody.innerHTML = lista.map(p => {
    const v = obtenerVenta(p.ventaId);
    const c = v ? obtenerCliente(v.clienteId) : null;
    const nombreCliente = c ? escaparHTML(c.nombre) : "<em style='color:var(--gray-400)'>Eliminado</em>";
    const observacion = p.observacion ? escaparHTML(p.observacion) : "<span style='color:var(--gray-400)'>—</span>";
    return `<tr><td>${escaparHTML(p.fecha)}</td><td>${nombreCliente}</td><td><span class="chip chip-success">${dinero(p.monto)}</span></td><td>${observacion}</td><td><div class="btn-group"><button class="btn-sm" data-action="recibo-pago" data-id="${escaparHTML(p.id)}">Recibo</button><button class="btn-sm" data-action="editar-pago" data-id="${escaparHTML(p.id)}">Editar</button></div></td></tr>`;
  }).join("");
}

function renderTodo() { actualizarSelects(); renderDashboard(); renderClientes(); renderVentas(); renderPagos(); }

$("formCliente").addEventListener("submit", async e => {
  e.preventDefault();
  const nombre = $("clienteNombre").value.trim();
  const telefono = $("clienteTelefono").value.trim();
  if (!nombre) return;
  if (data.clientes.some(c => c.nombre.toLowerCase() === nombre.toLowerCase())) return toast("Ya existe un cliente con ese nombre.", "error");

  const { error } = await db.from("clientes").insert([{ nombre, telefono, owner_id: currentBusinessOwner }]);
  if (error) return console.error(error), toast("Error al guardar cliente.", "error");

  e.target.reset(); await cargar(); renderTodo(); toast("Cliente guardado ✓", "success");
});

$("formVenta").addEventListener("submit", async e => {
  e.preventDefault();
  if (data.clientes.length === 0) return toast("Primero agrega un cliente.", "error");
  const total = Number($("ventaTotal").value);
  const abonoInicial = Number($("ventaAbono").value || 0);
  if (total <= 0) return toast("El total debe ser mayor a cero.", "error");
  if (abonoInicial > total) return toast("El abono no puede superar el total.", "error");

  const { error } = await db.from("ventas").insert([{
    cliente_id: $("ventaCliente").value,
    owner_id: currentBusinessOwner,
    fecha: fechaActual(),
    total,
    abono_inicial: abonoInicial,
    observaciones: $("ventaObs").value.trim()
  }]);
  if (error) return console.error(error), toast("Error al registrar venta.", "error");

  e.target.reset(); await cargar(); renderTodo(); toast("Venta registrada ✓", "success");
});

$("formPago").addEventListener("submit", async e => {
  e.preventDefault();
  const ventaId = $("pagoVenta").value;
  const venta = obtenerVenta(ventaId);
  if (!venta) return toast("Selecciona una cuenta pendiente.", "error");
  const monto = Number($("pagoMonto").value);
  const saldo = saldoVenta(venta);
  if (monto <= 0) return toast("El monto debe ser mayor a cero.", "error");
  if (monto > saldo) return toast(`El monto supera el saldo (${dinero(saldo)}).`, "error");

  const { error } = await db.from("pagos").insert([{
    venta_id: ventaId,
    owner_id: currentBusinessOwner,
    fecha: fechaActual(),
    monto,
    observacion: $("pagoObs").value.trim()
  }]);
  if (error) return console.error(error), toast("Error al registrar pago.", "error");

  e.target.reset(); await cargar(); renderTodo(); toast("Pago registrado ✓", "success");
});

$("pagoVenta").addEventListener("change", actualizarInfoSaldo);
$("buscador").addEventListener("input", renderClientes);
$("filtroEstadoVenta").addEventListener("change", renderVentas);

function verCliente(clienteId) {
  const cliente = obtenerCliente(clienteId);
  if (!cliente) return;
  const ventas = ventasDeCliente(clienteId);
  const r = resumenCliente(clienteId);
  $("modalTitulo").textContent = cliente.nombre;
  $("modalAvatar").textContent = iniciales(cliente.nombre);
  $("modalTelefono").textContent = cliente.telefono ? "📞 " + cliente.telefono : "";

  let html = `<div class="modal-stats"><div class="modal-stat"><span>Total vendido</span><strong>${dinero(r.vendido)}</strong></div><div class="modal-stat"><span>Total cobrado</span><strong class="success">${dinero(r.abonado)}</strong></div><div class="modal-stat"><span>Deuda pendiente</span><strong class="${r.deuda > 0 ? "danger" : "success"}">${dinero(r.deuda)}</strong></div></div><p class="modal-section-title">Historial de ventas</p>`;

  if (ventas.length === 0) {
    html += `<p style="color:var(--gray-400);font-size:14px">Este cliente no tiene ventas aún.</p>`;
  } else {
    html += `<div class="table-wrap"><table><thead><tr><th>Fecha</th><th>Total</th><th>Cobrado</th><th>Saldo</th><th>Descripción</th></tr></thead><tbody>`;
    html += ventas.map(v => `<tr><td>${escaparHTML(v.fecha)}</td><td>${dinero(v.total)}</td><td>${dinero(totalAbonadoVenta(v))}</td><td><span class="chip ${saldoVenta(v) > 0 ? "chip-danger" : "chip-success"}">${saldoVenta(v) > 0 ? dinero(saldoVenta(v)) : "Pagada"}</span></td><td style="max-width:160px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${v.observaciones ? escaparHTML(v.observaciones) : "—"}</td></tr>`).join("");
    html += `</tbody></table></div>`;
  }

  $("modalContenido").innerHTML = html;
  $("modalCliente").classList.add("show");
}

$("cerrarModal").addEventListener("click", () => $("modalCliente").classList.remove("show"));
$("modalCliente").addEventListener("click", e => { if (e.target.id === "modalCliente") $("modalCliente").classList.remove("show"); });

async function eliminarCliente(clienteId) {
  if (data.ventas.some(v => v.clienteId === clienteId)) return toast("No se puede eliminar: el cliente tiene ventas.", "error");
  if (!confirm("¿Eliminar este cliente?")) return;
  const { error } = await db.from("clientes").delete()
    .eq("id", clienteId)
    .eq("owner_id", currentBusinessOwner);
  if (error) return console.error(error), toast("Error al eliminar cliente.", "error");
  await cargar(); renderTodo(); toast("Cliente eliminado.");
}

async function eliminarVenta(ventaId) {
  if (!confirm("¿Eliminar esta venta y sus pagos relacionados?")) return;
  const { error } = await db.from("ventas").delete()
    .eq("id", ventaId)
    .eq("owner_id", currentBusinessOwner);
  if (error) return console.error(error), toast("Error al eliminar venta.", "error");
  await cargar(); renderTodo(); toast("Venta eliminada.");
}

function abrirEdicion(tipo, id) {
  editando = { tipo, id };
  const form = $("formEdicion");

  if (tipo === "cliente") {
    const cliente = obtenerCliente(id);
    if (!cliente) return;
    $("editTitulo").textContent = "Editar cliente";
    form.innerHTML = `
      <div class="field"><label for="editNombre">Nombre</label><input id="editNombre" required value="${escaparHTML(cliente.nombre)}"></div>
      <div class="field"><label for="editTelefono">Teléfono</label><input id="editTelefono" value="${escaparHTML(cliente.telefono)}"></div>
      <button class="btn-primary full" type="submit">Guardar cambios</button>`;
  }

  if (tipo === "venta") {
    const venta = obtenerVenta(id);
    if (!venta) return;
    $("editTitulo").textContent = "Editar venta";
    const opciones = data.clientes.map(c =>
      `<option value="${escaparHTML(c.id)}" ${c.id === venta.clienteId ? "selected" : ""}>${escaparHTML(c.nombre)}</option>`
    ).join("");
    form.innerHTML = `
      <div class="field"><label for="editVentaCliente">Cliente</label><select id="editVentaCliente" required>${opciones}</select></div>
      <div class="field"><label for="editFecha">Fecha</label><input id="editFecha" type="date" required value="${escaparHTML(venta.fecha)}"></div>
      <div class="field-row">
        <div class="field"><label for="editTotal">Total</label><input id="editTotal" type="number" step="0.01" min="0.01" required value="${venta.total}"></div>
        <div class="field"><label for="editAbono">Abono inicial</label><input id="editAbono" type="number" step="0.01" min="0" required value="${venta.abonoInicial}"></div>
      </div>
      <div class="field"><label for="editObservaciones">Descripción</label><textarea id="editObservaciones" rows="3">${escaparHTML(venta.observaciones)}</textarea></div>
      <button class="btn-primary full" type="submit">Guardar cambios</button>`;
  }

  if (tipo === "pago") {
    const pago = data.pagos.find(p => p.id === id);
    if (!pago) return;
    $("editTitulo").textContent = "Editar pago";
    form.innerHTML = `
      <div class="field"><label for="editFecha">Fecha</label><input id="editFecha" type="date" required value="${escaparHTML(pago.fecha)}"></div>
      <div class="field"><label for="editMonto">Monto</label><input id="editMonto" type="number" step="0.01" min="0.01" required value="${pago.monto}"></div>
      <div class="field"><label for="editObservacion">Nota</label><textarea id="editObservacion" rows="3">${escaparHTML(pago.observacion)}</textarea></div>
      <button class="btn-primary full" type="submit">Guardar cambios</button>`;
  }

  $("modalEdicion").classList.add("show");
}

$("formEdicion").addEventListener("submit", async event => {
  event.preventDefault();
  if (!editando) return;
  let error;

  if (editando.tipo === "cliente") {
    const nombre = $("editNombre").value.trim();
    if (data.clientes.some(c => c.id !== editando.id && c.nombre.toLowerCase() === nombre.toLowerCase())) {
      return toast("Ya existe otro cliente con ese nombre.", "error");
    }
    ({ error } = await db.from("clientes").update({
      nombre,
      telefono: $("editTelefono").value.trim()
    }).eq("id", editando.id).eq("owner_id", currentBusinessOwner));
  }

  if (editando.tipo === "venta") {
    const venta = obtenerVenta(editando.id);
    const total = Number($("editTotal").value);
    const abonoInicial = Number($("editAbono").value);
    const pagos = pagosDeVenta(venta.id);
    if (abonoInicial < 0 || total <= 0 || abonoInicial + pagos > total) {
      return toast(`El total no puede ser menor a lo ya cobrado (${dinero(abonoInicial + pagos)}).`, "error");
    }
    ({ error } = await db.from("ventas").update({
      cliente_id: $("editVentaCliente").value,
      fecha: $("editFecha").value,
      total,
      abono_inicial: abonoInicial,
      observaciones: $("editObservaciones").value.trim()
    }).eq("id", editando.id).eq("owner_id", currentBusinessOwner));
  }

  if (editando.tipo === "pago") {
    const pago = data.pagos.find(p => p.id === editando.id);
    const venta = obtenerVenta(pago.ventaId);
    const monto = Number($("editMonto").value);
    const maximo = saldoVenta(venta) + pago.monto;
    if (monto <= 0 || monto > maximo) {
      return toast(`El pago no puede superar ${dinero(maximo)}.`, "error");
    }
    ({ error } = await db.from("pagos").update({
      fecha: $("editFecha").value,
      monto,
      observacion: $("editObservacion").value.trim()
    }).eq("id", editando.id).eq("owner_id", currentBusinessOwner));
  }

  if (error) return console.error(error), toast("No se pudieron guardar los cambios.", "error");
  $("modalEdicion").classList.remove("show");
  editando = null;
  await cargar();
  renderTodo();
  toast("Cambios guardados ✓", "success");
});

$("cerrarEdicion").addEventListener("click", () => $("modalEdicion").classList.remove("show"));
$("modalEdicion").addEventListener("click", e => {
  if (e.target.id === "modalEdicion") $("modalEdicion").classList.remove("show");
});

function enviarWhatsApp(clienteId) {
  const cliente = obtenerCliente(clienteId);
  if (!cliente?.telefono) return toast("Este cliente no tiene teléfono.", "error");
  const deuda = resumenCliente(cliente.id).deuda;
  if (deuda <= 0) return toast("Este cliente no tiene deuda pendiente.", "error");
  const numero = cliente.telefono.replace(/\D/g, "");
  if (numero.length < 7) return toast("Revisa el teléfono del cliente e incluye el código de país.", "error");

  const mensaje = `Hola ${cliente.nombre}, te recordamos que tienes un saldo pendiente de ${dinero(deuda)} con ${data.configuracion.nombre}. Gracias.`;
  whatsappPendiente = { numero, clienteId };
  $("whatsAppDestino").textContent = `${cliente.nombre} · ${cliente.telefono}`;
  $("whatsAppMensaje").value = mensaje;
  $("modalWhatsApp").classList.add("show");
}

function cerrarWhatsApp() {
  whatsappPendiente = null;
  $("modalWhatsApp").classList.remove("show");
}

$("cerrarWhatsApp").addEventListener("click", cerrarWhatsApp);
$("cancelarWhatsApp").addEventListener("click", cerrarWhatsApp);
$("modalWhatsApp").addEventListener("click", event => {
  if (event.target.id === "modalWhatsApp") cerrarWhatsApp();
});
$("confirmarWhatsApp").addEventListener("click", () => {
  if (!whatsappPendiente) return;
  const mensaje = $("whatsAppMensaje").value.trim();
  if (!mensaje) return toast("Escribe un mensaje antes de continuar.", "error");
  window.open(
    `https://wa.me/${whatsappPendiente.numero}?text=${encodeURIComponent(mensaje)}`,
    "_blank",
    "noopener"
  );
  cerrarWhatsApp();
});

function generarReciboPago(pagoId) {
  const pago = data.pagos.find(item => item.id === pagoId);
  const venta = pago ? obtenerVenta(pago.ventaId) : null;
  const cliente = venta ? obtenerCliente(venta.clienteId) : null;
  if (!pago || !venta || !cliente) {
    return toast("No se encontraron los datos completos del recibo.", "error");
  }

  const ventana = window.open("", "_blank", "width=760,height=900");
  if (!ventana) return toast("Permite las ventanas emergentes para generar el recibo.", "error");
  ventana.opener = null;

  const logo = data.configuracion.logoUrl
    ? escaparHTML(data.configuracion.logoUrl)
    : new URL(LOGO_PREDETERMINADO, location.href).href;
  const numeroRecibo = pago.id.replace(/-/g, "").slice(-8).toUpperCase();
  const telefonoNegocio = data.configuracion.telefono
    ? `<div>${escaparHTML(data.configuracion.telefono)}</div>`
    : "";

  ventana.document.write(`<!doctype html>
  <html lang="es"><head><meta charset="utf-8"><title>Recibo ${numeroRecibo}</title>
  <style>
    *{box-sizing:border-box}body{margin:0;background:#eef2f7;font-family:Arial,sans-serif;color:#172033}
    .sheet{width:680px;max-width:100%;margin:28px auto;background:#fff;padding:38px;border-radius:14px;box-shadow:0 8px 30px #0001}
    header{display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #e5e7eb;padding-bottom:22px}
    .brand{display:flex;align-items:center;gap:15px}.brand img{width:92px;height:92px;object-fit:contain}
    h1{font-size:25px;margin:0}.muted{color:#64748b;font-size:13px;line-height:1.5}.receipt{text-align:right}
    .receipt strong{display:block;font-size:20px;color:#2563eb}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:28px 0}
    .box{border:1px solid #e5e7eb;border-radius:10px;padding:16px}.label{font-size:11px;text-transform:uppercase;color:#64748b;font-weight:bold;margin-bottom:6px}
    .amount{text-align:center;background:#eff6ff;border:1px solid #bfdbfe;border-radius:12px;padding:22px;margin:20px 0}
    .amount span{display:block;color:#64748b;font-size:12px;text-transform:uppercase}.amount strong{font-size:34px;color:#15803d}
    table{width:100%;border-collapse:collapse;margin-top:22px}td{padding:12px;border-bottom:1px solid #e5e7eb}td:last-child{text-align:right;font-weight:bold}
    footer{text-align:center;color:#64748b;font-size:12px;margin-top:32px}.actions{text-align:center;margin:20px}
    button{border:0;background:#2563eb;color:#fff;padding:11px 20px;border-radius:8px;font-weight:bold;cursor:pointer}
    @media print{body{background:#fff}.sheet{margin:0;width:100%;box-shadow:none;border-radius:0}.actions{display:none}@page{margin:12mm}}
  </style></head><body>
  <div class="actions"><button onclick="window.print()">Imprimir o guardar como PDF</button></div>
  <main class="sheet">
    <header>
      <div class="brand"><img src="${logo}" alt=""><div><h1>${escaparHTML(data.configuracion.nombre)}</h1>${telefonoNegocio}<div class="muted">Comprobante de pago</div></div></div>
      <div class="receipt"><strong>RECIBO</strong><div class="muted">N.º ${numeroRecibo}<br>${escaparHTML(pago.fecha)}</div></div>
    </header>
    <div class="grid">
      <div class="box"><div class="label">Recibido de</div><strong>${escaparHTML(cliente.nombre)}</strong><div class="muted">${escaparHTML(cliente.telefono || "Sin teléfono")}</div></div>
      <div class="box"><div class="label">Concepto</div><strong>Abono a cuenta</strong><div class="muted">${escaparHTML(venta.observaciones || "Venta registrada")}</div></div>
    </div>
    <div class="amount"><span>Monto recibido</span><strong>${dinero(pago.monto)}</strong></div>
    <table>
      <tr><td>Total de la venta</td><td>${dinero(venta.total)}</td></tr>
      <tr><td>Total cobrado</td><td>${dinero(totalAbonadoVenta(venta))}</td></tr>
      <tr><td>Saldo pendiente actual</td><td>${dinero(saldoVenta(venta))}</td></tr>
      <tr><td>Nota</td><td>${escaparHTML(pago.observacion || "—")}</td></tr>
    </table>
    <footer>Gracias por su pago · Generado por MA One</footer>
  </main></body></html>`);
  ventana.document.close();
}

$("formConfiguracion").addEventListener("submit", async event => {
  event.preventDefault();
  const apariencia = leerAparienciaFormulario();
  const botonGuardar = event.currentTarget.querySelector('button[type="submit"]');
  if (botonGuardar) botonGuardar.disabled = true;
  let logoPath = quitarLogoSolicitado ? "" : (data.configuracion.logoPath || "");
  try {
    logoPath = await subirLogoNegocio($("configLogoArchivo").files[0]);
  } catch (error) {
    console.error(error);
    if (botonGuardar) botonGuardar.disabled = false;
    const mensaje = error?.message?.includes("Bucket not found")
      ? "Falta crear el almacenamiento de logos en Supabase."
      : (error?.message || "No se pudo subir el logo.");
    return toast(mensaje, "error");
  }
  const registro = {
    owner_id: currentBusinessOwner,
    nombre: $("configNombre").value.trim(),
    telefono: $("configTelefono").value.trim(),
    moneda: $("configMoneda").value,
    logo_url: logoPath,
    tema: apariencia.tema,
    color_primario: apariencia.colorPrimario,
    densidad: apariencia.densidad,
    bordes: apariencia.bordes
  };
  aplicarApariencia({ ...data.configuracion, ...apariencia });
  const { error } = await db.from("configuracion").upsert(registro, { onConflict: "owner_id" });
  if (botonGuardar) botonGuardar.disabled = false;
  if (error) {
    console.error(error);
    const mensaje = error.code === "PGRST205" || error.code === "42P01"
      ? "Falta crear la tabla configuracion en Supabase."
      : "Apariencia guardada en este dispositivo. Falta ejecutar la actualización SQL.";
    return toast(mensaje, "error");
  }
  const logoVisible = await resolverLogoGuardado(registro.logo_url);
  data.configuracion = {
    nombre: registro.nombre,
    telefono: registro.telefono,
    moneda: registro.moneda,
    logoUrl: logoVisible,
    logoPath: registro.logo_url,
    tema: registro.tema,
    colorPrimario: registro.color_primario,
    densidad: registro.densidad,
    bordes: registro.bordes
  };
  quitarLogoSolicitado = false;
  $("configLogoArchivo").value = "";
  aplicarConfiguracion();
  renderTodo();
  toast("Configuración guardada ✓", "success");
});

$("btnThemeToggle").addEventListener("click", () => {
  const temaActual = document.documentElement.dataset.theme;
  data.configuracion.tema = temaActual === "dark" ? "light" : "dark";
  $("configTema").value = data.configuracion.tema;
  aplicarApariencia(data.configuracion);
});

["configTema", "configColor", "configDensidad", "configBordes"].forEach(id => {
  $(id).addEventListener("input", () => {
    const apariencia = leerAparienciaFormulario();
    data.configuracion = { ...data.configuracion, ...apariencia };
    $("configColorValue").textContent = apariencia.colorPrimario;
    aplicarApariencia(data.configuracion);
  });
});

const mediaTemaOscuro = matchMedia("(prefers-color-scheme: dark)");
const actualizarTemaSistema = () => {
  if (data.configuracion.tema === "system") aplicarApariencia(data.configuracion);
};
if (mediaTemaOscuro.addEventListener) mediaTemaOscuro.addEventListener("change", actualizarTemaSistema);
else if (mediaTemaOscuro.addListener) mediaTemaOscuro.addListener(actualizarTemaSistema);

document.addEventListener("click", event => {
  const boton = event.target.closest("[data-action]");
  if (!boton) return;
  const id = boton.dataset.id;
  if (boton.dataset.action === "ver-cliente") verCliente(id);
  if (boton.dataset.action === "eliminar-cliente") eliminarCliente(id);
  if (boton.dataset.action === "eliminar-venta") eliminarVenta(id);
  if (boton.dataset.action === "editar-cliente") abrirEdicion("cliente", id);
  if (boton.dataset.action === "editar-venta") abrirEdicion("venta", id);
  if (boton.dataset.action === "editar-pago") abrirEdicion("pago", id);
  if (boton.dataset.action === "whatsapp") enviarWhatsApp(id);
  if (boton.dataset.action === "recibo-pago") generarReciboPago(id);
  if (boton.dataset.action === "quitar-auxiliar") quitarAuxiliar();
  if (boton.dataset.action === "soporte-cuenta") entrarSoporte(id);
  if (boton.dataset.action === "estado-cuenta") cambiarEstadoCuenta(id, boton.dataset.active === "true");
});

const secciones = {
  dashboard: { title: "Inicio", search: false },
  clientes: { title: "Clientes", search: true },
  ventas: { title: "Ventas", search: false },
  pagos: { title: "Pagos", search: false },
  configuracion: { title: "Configuración", search: false }
};
secciones.equipo = { title: "Equipo", search: false };
secciones.administracion = { title: "Administración", search: false };
document.querySelectorAll(".nav-item").forEach(btn => btn.addEventListener("click", () => { irA(btn.dataset.section); cerrarSidebar(); }));
function irA(sec) {
  document.querySelectorAll(".nav-item").forEach(b => b.classList.toggle("active", b.dataset.section === sec));
  document.querySelectorAll(".section").forEach(s => s.classList.toggle("active", s.id === "sec-" + sec));
  const conf = secciones[sec];
  if (conf) { $("pageTitle").textContent = conf.title; $("searchWrap").style.display = conf.search ? "flex" : "none"; }
}

function aplicarPermisosInterfaz() {
  const esPropietario = Boolean(currentUser)
    && currentRole === "propietario"
    && currentBusinessOwner === ownBusinessOwner;
  document.querySelectorAll(".role-owner").forEach(el => {
    el.style.display = esPropietario ? "flex" : "none";
  });
  document.querySelectorAll(".role-admin").forEach(el => {
    el.style.display = isPlatformAdmin ? "flex" : "none";
  });
  $("btnSalirSoporte").style.display = currentBusinessOwner !== ownBusinessOwner ? "inline-block" : "none";
  const puedeConfigurar = Boolean(currentUser) && (esPropietario || isPlatformAdmin);
  $("formConfiguracion").querySelectorAll("input, select, button").forEach(control => {
    control.disabled = !puedeConfigurar;
  });
}

async function cargarContextoUsuario() {
  await db.rpc("aceptar_invitacion_auxiliar");
  const { data: contexto, error } = await db.rpc("obtener_contexto_usuario");
  if (error) throw error;
  const ctx = contexto?.[0];
  if (!ctx) throw new Error("No se encontró el contexto del usuario.");
  if (!ctx.cuenta_activa) throw new Error("Esta cuenta está suspendida. Contacta al administrador.");
  currentBusinessOwner = ctx.owner_id;
  ownBusinessOwner = ctx.owner_id;
  currentRole = ctx.rol || "propietario";
  isPlatformAdmin = Boolean(ctx.es_admin);
  aplicarPermisosInterfaz();
}

$("menuBtn").addEventListener("click", () => { $("sidebar").classList.add("open"); $("overlay").classList.add("show"); });
function cerrarSidebar() { $("sidebar").classList.remove("open"); $("overlay").classList.remove("show"); }
$("sidebarClose").addEventListener("click", cerrarSidebar);
$("overlay").addEventListener("click", cerrarSidebar);

function mostrarAcceso(mensaje = "", permitirReintento = false) {
  $("authBackdrop").classList.remove("hidden");
  $("btnLogout").style.display = "none";
  $("authError").classList.remove("success");
  $("authError").textContent = mensaje;
  $("btnRetryConnection").style.display = permitirReintento ? "block" : "none";
}

function cambiarModoAuth(modo) {
  authMode = modo;
  const esRegistro = modo === "register";

  $("authTitle").textContent = esRegistro ? "Crear usuario" : "MA One";
  $("authSubtitle").textContent = esRegistro ? "Registra tu primera cuenta" : "Acceso privado";
  $("confirmPasswordField").style.display = esRegistro ? "block" : "none";
  $("loginPasswordConfirm").required = esRegistro;
  $("loginPassword").autocomplete = esRegistro ? "new-password" : "current-password";
  $("btnLogin").textContent = esRegistro ? "Crear cuenta" : "Iniciar sesión";
  $("btnAuthMode").textContent = esRegistro
    ? "¿Ya tienes usuario? Iniciar sesión"
    : "¿No tienes usuario? Crear una cuenta";
  $("authHelp").textContent = esRegistro
    ? "Usa una contraseña de al menos 6 caracteres."
    : "Ingresa con tu correo y contraseña.";
  $("authError").textContent = "";
  $("authError").classList.remove("success");
  $("loginPasswordConfirm").value = "";
  $("btnForgotPassword").style.display = esRegistro ? "none" : "block";
}

async function cargarAuxiliar() {
  if (currentRole !== "propietario") return;
  const { data: auxiliar, error } = await db.rpc("obtener_auxiliar");
  const contenedor = $("estadoAuxiliar");
  if (error) {
    console.error(error);
    contenedor.textContent = "No se pudo cargar el auxiliar.";
    return;
  }
  const item = auxiliar?.[0];
  if (!item) {
    contenedor.innerHTML = "No hay auxiliar vinculado ni invitación pendiente.";
    return;
  }
  if (item.email) {
    contenedor.innerHTML = `Auxiliar activo: <strong>${escaparHTML(item.email)}</strong><br><button class="btn-sm danger" data-action="quitar-auxiliar">Quitar auxiliar</button>`;
  } else {
    contenedor.innerHTML = `Invitación pendiente para: <strong>${escaparHTML(item.invitacion_email)}</strong><br><button class="btn-sm danger" data-action="quitar-auxiliar">Cancelar invitación</button>`;
  }
}

async function cargarAdmin() {
  if (!isPlatformAdmin) return;
  const tbody = $("tablaAdmin");
  tbody.innerHTML = `<tr class="td-empty"><td colspan="6">Cargando cuentas...</td></tr>`;
  const { data: cuentas, error } = await db.rpc("admin_listar_cuentas");
  if (error) {
    console.error(error);
    tbody.innerHTML = `<tr class="td-empty"><td colspan="6">No se pudo cargar administración.</td></tr>`;
    return;
  }
  if (!cuentas?.length) {
    tbody.innerHTML = `<tr class="td-empty"><td colspan="6">No hay cuentas registradas.</td></tr>`;
    return;
  }
  tbody.innerHTML = cuentas.map(cuenta => {
    const estado = cuenta.activa ? "Activa" : "Suspendida";
    const accionEstado = cuenta.activa ? "Suspender" : "Activar";
    return `<tr>
      <td><strong>${escaparHTML(cuenta.nombre_negocio)}</strong></td>
      <td>${escaparHTML(cuenta.email)}</td>
      <td>${escaparHTML(cuenta.auxiliar_email || "—")}</td>
      <td>${cuenta.clientes} clientes · ${cuenta.ventas} ventas · ${cuenta.pagos} pagos</td>
      <td><span class="chip ${cuenta.activa ? "chip-success" : "chip-danger"}">${estado}</span></td>
      <td><div class="btn-group">
        <button class="btn-sm" data-action="soporte-cuenta" data-id="${escaparHTML(cuenta.owner_id)}">Soporte</button>
        <button class="btn-sm danger" data-action="estado-cuenta" data-id="${escaparHTML(cuenta.owner_id)}" data-active="${cuenta.activa ? "false" : "true"}">${accionEstado}</button>
      </div></td>
    </tr>`;
  }).join("");
}

async function entrarSoporte(ownerId) {
  if (!isPlatformAdmin) return;
  currentBusinessOwner = ownerId;
  currentRole = "propietario";
  aplicarPermisosInterfaz();
  await cargar();
  renderTodo();
  irA("dashboard");
  toast("Modo soporte activado.", "success");
}

async function salirSoporte() {
  currentBusinessOwner = ownBusinessOwner;
  currentRole = "propietario";
  aplicarPermisosInterfaz();
  await cargar();
  renderTodo();
  irA("administracion");
}

$("formAuxiliar").addEventListener("submit", async event => {
  event.preventDefault();
  const email = $("auxiliarEmail").value.trim();
  if (!email) return;
  const { error } = await db.rpc("invitar_auxiliar", { p_email: email });
  if (error) {
    console.error(error);
    return toast(error.message || "No se pudo crear la invitación.", "error");
  }
  event.target.reset();
  await cargarAuxiliar();
  toast("Invitación creada. El auxiliar debe registrarse con ese correo.", "success");
});

async function quitarAuxiliar() {
  if (!confirm("¿Quitar el auxiliar o cancelar la invitación pendiente?")) return;
  const { error } = await db.rpc("quitar_auxiliar");
  if (error) {
    console.error(error);
    return toast("No se pudo quitar el auxiliar.", "error");
  }
  await cargarAuxiliar();
  toast("Auxiliar actualizado.", "success");
}

$("btnRefrescarAdmin").addEventListener("click", cargarAdmin);
$("btnSalirSoporte").addEventListener("click", salirSoporte);

async function cambiarEstadoCuenta(ownerId, activa) {
  const accion = activa ? "activar" : "suspender";
  if (!confirm(`¿Seguro que quieres ${accion} esta cuenta?`)) return;
  const { error } = await db.rpc("admin_cambiar_estado_cuenta", {
    p_owner: ownerId,
    p_activa: activa
  });
  if (error) {
    console.error(error);
    return toast("No se pudo cambiar el estado de la cuenta.", "error");
  }
  await cargarAdmin();
  toast("Estado actualizado.", "success");
}

async function abrirAplicacion(user) {
  currentUser = user;
  $("authBackdrop").classList.add("hidden");
  $("btnLogout").style.display = "inline-block";
  try {
    await cargarContextoUsuario();
  } catch (error) {
    console.error(error);
    mostrarAcceso(error.message || "No se pudo cargar el contexto del usuario.");
    return;
  }
  const cargado = await cargar();
  if (cargado) {
    renderTodo();
    await cargarAuxiliar();
    await cargarAdmin();
    $("btnRetryConnection").style.display = "none";
  }
}

$("formLogin").addEventListener("submit", async event => {
  event.preventDefault();
  $("authError").textContent = "";
  $("authError").classList.remove("success");
  $("btnLogin").disabled = true;

  const email = $("loginEmail").value.trim();
  const password = $("loginPassword").value;

  if (authMode === "register") {
    if (password !== $("loginPasswordConfirm").value) {
      $("btnLogin").disabled = false;
      $("authError").textContent = "Las contraseñas no coinciden.";
      return;
    }

    const { data: authData, error } = await db.auth.signUp({ email, password });
    $("btnLogin").disabled = false;

    if (error) {
      console.error(error);
      $("authError").textContent = error.message.includes("already registered")
        ? "Este correo ya está registrado."
        : "No se pudo crear el usuario: " + error.message;
      return;
    }

    if (authData.session && authData.user) {
      event.target.reset();
      await abrirAplicacion(authData.user);
      toast("Usuario creado correctamente ✓", "success");
      return;
    }

    event.target.reset();
    cambiarModoAuth("login");
    $("authError").classList.add("success");
    $("authError").textContent = "Cuenta creada. Revisa tu correo para confirmarla.";
    return;
  }

  const { data: authData, error } = await db.auth.signInWithPassword({ email, password });

  $("btnLogin").disabled = false;
  if (error) {
    console.error(error);
    mostrarAcceso("Correo o contraseña incorrectos.");
    return;
  }

  event.target.reset();
  await abrirAplicacion(authData.user);
});

$("btnAuthMode").addEventListener("click", () => {
  cambiarModoAuth(authMode === "login" ? "register" : "login");
});

$("btnForgotPassword").addEventListener("click", async () => {
  const email = $("loginEmail").value.trim();
  if (!email) {
    $("authError").textContent = "Escribe primero tu correo electrónico.";
    $("loginEmail").focus();
    return;
  }
  const redirectTo = `${location.origin}${location.pathname}`;
  const { error } = await db.auth.resetPasswordForEmail(email, { redirectTo });
  if (error) {
    console.error(error);
    $("authError").textContent = "No se pudo enviar el correo de recuperación.";
    return;
  }
  $("authError").classList.add("success");
  $("authError").textContent = "Te enviamos un enlace para cambiar la contraseña.";
});

$("btnRetryConnection").addEventListener("click", async () => {
  $("btnRetryConnection").disabled = true;
  $("authError").textContent = "Comprobando conexión...";
  await iniciarConexion();
  $("btnRetryConnection").disabled = false;
});

$("formPassword").addEventListener("submit", async event => {
  event.preventDefault();
  const { error } = await db.auth.updateUser({ password: $("newPassword").value });
  if (error) return console.error(error), toast("No se pudo cambiar la contraseña.", "error");
  event.target.reset();
  $("modalPassword").classList.remove("show");
  toast("Contraseña actualizada ✓", "success");
});

$("btnLogout").addEventListener("click", async () => {
  await db.auth.signOut();
  currentUser = null;
  currentBusinessOwner = null;
  ownBusinessOwner = null;
  currentRole = "propietario";
  isPlatformAdmin = false;
  data = {
    clientes: [],
    ventas: [],
    pagos: [],
    configuracion: {
      nombre: "MA One",
      telefono: "",
      moneda: "USD",
      logoUrl: "",
      logoPath: "",
      ...cargarAparienciaLocal()
    }
  };
  aplicarPermisosInterfaz();
  cambiarModoAuth("login");
  mostrarAcceso();
});

async function iniciarConexion() {
  if (!configuracionValida()) {
    mostrarAcceso("Configura la URL pública de Supabase en config.js.");
    $("formLogin").querySelectorAll("input, button").forEach(control => control.disabled = true);
    $("btnAuthMode").disabled = true;
    $("btnForgotPassword").disabled = true;
    return;
  }

  if (!db) {
    db = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    });
  }

  if (!authListenerReady) {
    db.auth.onAuthStateChange(event => {
      if (event === "PASSWORD_RECOVERY") {
        $("authBackdrop").classList.add("hidden");
        $("modalPassword").classList.add("show");
      }
    });
    authListenerReady = true;
  }

  let resultado;
  try {
    resultado = await conTimeout(db.auth.getSession());
  } catch (error) {
    console.error("No se pudo contactar Auth de Supabase:", error);
    mostrarAcceso(mensajeErrorSupabase(error), true);
    return;
  }

  const { data: { session }, error } = resultado;

  if (error) {
    console.error(error);
    const mensaje = mensajeErrorSupabase(error, "autenticación");
    if (/jwt|refresh token|session/i.test(`${error.message || ""}`)) {
      await db.auth.signOut({ scope: "local" });
      mostrarAcceso("La sesión anterior venció. Inicia sesión nuevamente.");
    } else {
      mostrarAcceso(mensaje, true);
    }
    return;
  }

  if (session?.user) await abrirAplicacion(session.user);
  else mostrarAcceso();
}

(async function init() {
  data.configuracion = { ...data.configuracion, ...cargarAparienciaLocal() };
  aplicarConfiguracion();
  await iniciarConexion();
})();
