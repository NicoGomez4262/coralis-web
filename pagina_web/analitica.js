// ============================================================
// analitica.js — Analítica del Inicio del panel (la usa principal.js)
//
// ESCALA DE TIEMPO DE CORALIS: 1 minuto de medición = 1 día.
// Cada lectura de la Raspberry (una por minuto) representa un día
// en la vida del coral. Por eso aquí todo se cuenta en "días".
//
// Qué calcula, en orden:
//   1) Serie diaria: agrupa las lecturas por minuto (= día) y numera los días
//   2) Índice de blanqueo acumulado de cada día (0 % a 100 %)
//   3) Ventana de análisis: los últimos 7, 30, 90 o 365 días
//   4) Variación % = |dato inicial − dato final| / dato inicial × 100
//   5) Gráfica y franja del blanqueo, días más blancos y más sanos
//   6) Tiempo en cada nivel (ideal / medio / crítico)
//   7) Umbrales superados: veces que salió del ideal y rachas
// ============================================================

const MINUTO = 60 * 1000;

// ---------- PARÁMETROS DEL ÍNDICE DE BLANQUEO ----------
// Cuánto sube el índice por día con estrés máximo (nivel crítico)
// y cuánto baja por día cuando todo vuelve al rango ideal.
// Con estos valores: ~8 días seguidos en crítico lo blanquean del todo
// (en nivel medio tarda entre 15 y 55 días),
// y se recupera por completo en ~25 días de agua ideal.
// (Son supuestos del modelo; se pueden ajustar.)
const SUBE_POR_DIA = 0.12;
const BAJA_POR_DIA = 0.04;

const NOMBRE_NIVEL = { ideal: "Ideal", medio: "Medio", critico: "Crítico" };

export function crearAnalitica({ Chart, RANGOS, VARIABLES, nivelDe, horaCompleta }) {

  // ---------- AYUDAS ----------
  const limitar = (x, min = 0, max = 1) => Math.min(max, Math.max(min, x));
  const nombres = Object.keys(VARIABLES);
  const fmt = (n, dec) => (n === null || isNaN(n) ? "--" : n.toFixed(dec));
  const formatoEntero = (n) => n.toLocaleString("es-CO");

  function promedio(lista) {
    const v = lista.filter((n) => !isNaN(n));
    return v.length ? v.reduce((s, n) => s + n, 0) / v.length : NaN;
  }

  // Color del coral según el blanqueo (de coral vivo a blanco hueso)
  function colorBlanqueo(b) {
    const vivo = [255, 107, 107];
    const hueso = [244, 239, 228];
    const c = vivo.map((x, i) => Math.round(x + (hueso[i] - x) * b));
    return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
  }

  function estadoBlanqueo(b) {
    if (b < 0.3) return "vivo";
    if (b < 0.7) return "pálido";
    return "blanqueado";
  }

  // ---------- 2) ESTRÉS DE UN VALOR (0 = ideal, 1 = crítico) ----------
  // En nivel medio el estrés crece de 0.15 a 0.6 según lo cerca que esté del crítico.
  function estres(nombre, valor) {
    const nivel = nivelDe(nombre, valor);
    if (nivel === null) return null;
    if (nivel === "ideal") return 0;
    if (nivel === "critico") return 1;
    const r = RANGOS[nombre];
    const f = valor < r.idealMin
      ? (r.idealMin - valor) / (r.idealMin - r.criticoBajo)
      : (valor - r.idealMax) / (r.criticoAlto - r.idealMax);
    return 0.15 + 0.45 * limitar(f);
  }

  // ---------- 1) y 2) SERIE DIARIA + BLANQUEO ACUMULADO ----------
  // lecturas: todosLosDatos de principal.js (ordenadas de la más vieja a la más nueva)
  function serieDiaria(lecturas) {
    if (lecturas.length === 0) return { dias: [], porDia: new Map(), t0: null };
    const t0 = lecturas[0].hora.getTime();
    const grupos = new Map();
    for (const l of lecturas) {
      const dia = Math.round((l.hora.getTime() - t0) / MINUTO) + 1;   // el día 1 es la primera lectura
      if (!grupos.has(dia)) grupos.set(dia, []);
      grupos.get(dia).push(l);
    }

    const dias = [];
    let blanqueo = 0;
    for (const [dia, grupo] of [...grupos.entries()].sort((a, b) => a[0] - b[0])) {
      const d = { dia, n: grupo.length, hora: grupo[0].hora, niveles: {} };
      for (const nombre of nombres) {
        d[nombre] = promedio(grupo.map((l) => l[nombre]));
        d.niveles[nombre] = nivelDe(nombre, d[nombre]);
      }
      // Estrés del día = el de la PEOR variable (igual que la salud del coral)
      const estreses = nombres.map((nombre) => estres(nombre, d[nombre])).filter((e) => e !== null);
      d.estres = estreses.length ? Math.max(...estreses) : null;
      if (d.estres !== null) {
        blanqueo = limitar(blanqueo + SUBE_POR_DIA * d.estres - BAJA_POR_DIA * (d.estres === 0 ? 1 : 0));
      }
      d.blanqueo = blanqueo;
      const nivelesDia = Object.values(d.niveles).filter(Boolean);
      d.nivelCoral = nivelesDia.includes("critico") ? "critico" : nivelesDia.includes("medio") ? "medio" : nivelesDia.length ? "ideal" : null;
      dias.push(d);
    }
    return { dias, porDia: new Map(dias.map((d) => [d.dia, d])), t0 };
  }

  // ---------- 3) VENTANA DE ANÁLISIS ----------
  // casillas = todos los días de la ventana (con dato o null si ese día no llegó lectura)
  function ventana(serie, cantidadDias) {
    if (serie.dias.length === 0) return { casillas: [], dias: [], lecturas: 0, desde: 0, hasta: 0 };
    const hasta = serie.dias[serie.dias.length - 1].dia;
    const desde = Math.max(1, hasta - cantidadDias + 1);
    const casillas = [];
    for (let dia = desde; dia <= hasta; dia++) casillas.push({ dia, dato: serie.porDia.get(dia) ?? null });
    const dias = casillas.filter((c) => c.dato).map((c) => c.dato);
    return { casillas, dias, lecturas: dias.reduce((s, d) => s + d.n, 0), desde, hasta, cantidadDias };
  }

  // ---------- 5) GRÁFICA DEL BLANQUEO ----------
  const graficaBlanqueo = new Chart(document.getElementById("graficaBlanqueo"), {
    type: "line",
    data: {
      labels: [],
      datasets: [{
        label: "Blanqueo acumulado",
        data: [],
        borderColor: "#0a5a73",
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 5,
        pointBackgroundColor: "#0a5a73",
        tension: 0.25,
        spanGaps: true,
        fill: "origin",
        // Relleno: abajo coral vivo, arriba blanco hueso (como el coral)
        backgroundColor: (ctx) => {
          const area = ctx.chart.chartArea;
          if (!area) return "rgba(255, 107, 107, 0.3)";
          const g = ctx.chart.ctx.createLinearGradient(0, area.bottom, 0, area.top);
          g.addColorStop(0, "rgba(255, 107, 107, 0.55)");
          g.addColorStop(0.5, "rgba(247, 196, 180, 0.6)");
          g.addColorStop(1, "rgba(244, 239, 228, 0.95)");
          return g;
        },
      }],
    },
    options: {
      animation: false,   // con cientos de días, mejor dibujar de una vez
      aspectRatio: window.innerWidth < 700 ? 1.8 : 3.6,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "#062a3a",
          titleColor: "#8fe3dd",
          padding: 10,
          cornerRadius: 10,
          displayColors: false,
          callbacks: {
            label: (c) => `${c.formattedValue} % blanqueado`,
            afterLabel: (c) => {
              const d = graficaBlanqueo.$dias?.[c.dataIndex];
              return d ? "Medido: " + horaCompleta(d.hora) : "";
            },
          },
        },
      },
      scales: {
        x: { ticks: { maxTicksLimit: 8 }, grid: { display: false } },
        y: {
          min: 0,
          max: 100,
          ticks: { stepSize: 25, callback: (v) => v + " %" },
          grid: { color: "#e2eff1" },
          border: { display: false },
        },
      },
    },
  });

  function pintarBlanqueo(v) {
    graficaBlanqueo.data.labels = v.casillas.map((c) => "Día " + formatoEntero(c.dia));
    graficaBlanqueo.data.datasets[0].data = v.casillas.map((c) => (c.dato ? Math.round(c.dato.blanqueo * 100) : null));
    graficaBlanqueo.$dias = v.casillas.map((c) => c.dato);
    graficaBlanqueo.update();

    // Franja: un cuadrito por día con el color que tenía el coral
    const franja = document.getElementById("franjaDias");
    franja.style.gridTemplateColumns = `repeat(${v.casillas.length}, 1fr)`;
    franja.replaceChildren(...v.casillas.map((c) => {
      const celda = document.createElement("span");
      if (c.dato) {
        celda.style.background = colorBlanqueo(c.dato.blanqueo);
        celda.title = `Día ${formatoEntero(c.dia)}: ${Math.round(c.dato.blanqueo * 100)} % blanqueado`;
      } else {
        celda.className = "sin-dato";
        celda.title = `Día ${formatoEntero(c.dia)}: sin lectura`;
      }
      return celda;
    }));

    pintarExtremos(v);
  }

  // Qué variables estaban mal ese día (para explicar por qué se blanqueó)
  function causa(d) {
    const criticas = nombres.filter((n) => d.niveles[n] === "critico").map((n) => VARIABLES[n].nombre);
    const medias = nombres.filter((n) => d.niveles[n] === "medio").map((n) => VARIABLES[n].nombre);
    if (criticas.length) return "Crítico: " + criticas.join(", ");
    if (medias.length) return "Medio: " + medias.join(", ");
    return "Todo en rango ideal";
  }

  function itemDia(titulo, detalle, extra) {
    const li = document.createElement("li");
    const fuerte = document.createElement("strong");
    fuerte.textContent = titulo;
    const span = document.createElement("span");
    span.textContent = detalle;
    const small = document.createElement("small");
    small.textContent = extra;
    li.append(fuerte, span, small);
    return li;
  }

  function pintarExtremos(v) {
    const blancos = document.getElementById("diasBlancos");
    const sanos = document.getElementById("diasSanos");

    // Días más blancos: el pico de cada episodio de blanqueo (días seguidos con
    // índice > 2 %), ordenados del más blanco al menos blanco
    const episodios = [];
    let pico = null;
    for (const d of v.dias) {
      if (d.blanqueo > 0.02) {
        if (!pico || d.blanqueo > pico.blanqueo) pico = d;
      } else if (pico) {
        episodios.push(pico);
        pico = null;
      }
    }
    if (pico) episodios.push(pico);
    const elegidos = episodios.sort((a, b) => b.blanqueo - a.blanqueo).slice(0, 3);
    blancos.replaceChildren(...(elegidos.length
      ? elegidos.map((d) => itemDia(`Día ${formatoEntero(d.dia)}`, `${Math.round(d.blanqueo * 100)} % de blanqueo, coral ${estadoBlanqueo(d.blanqueo)}. ${causa(d)}.`, "Medido el " + horaCompleta(d.hora)))
      : [itemDia("Ninguno", "El coral no se blanqueó en esta ventana.", "")]));

    // Días más sanos: las rachas más largas con el coral vivo y todo en ideal
    const rachas = [];
    let actual = null;
    for (const c of v.casillas) {
      const sano = c.dato && c.dato.blanqueo < 0.05 && c.dato.nivelCoral === "ideal";
      if (sano) {
        if (!actual) actual = { desde: c.dato, hasta: c.dato, dias: 0 };
        actual.hasta = c.dato;
        actual.dias++;
      } else if (actual && c.dato) {
        rachas.push(actual);
        actual = null;
      }
    }
    if (actual) rachas.push(actual);
    const mejores = rachas.sort((a, b) => b.dias - a.dias).slice(0, 3);
    sanos.replaceChildren(...(mejores.length
      ? mejores.map((r) => itemDia(
          r.dias === 1 ? `Día ${formatoEntero(r.desde.dia)}` : `Días ${formatoEntero(r.desde.dia)} a ${formatoEntero(r.hasta.dia)}`,
          `${r.dias} ${r.dias === 1 ? "día" : "días"} seguidos con todo en rango ideal y el coral vivo.`,
          "Desde el " + horaCompleta(r.desde.hora)))
      : [itemDia("Ninguno", "No hubo días con todo en rango ideal y el coral vivo.", "")]));
  }

  // ---------- 4) VARIACIÓN % EN LA VENTANA ----------
  function pintarVariaciones(v) {
    for (const nombre of nombres) {
      const vv = VARIABLES[nombre];
      const caja = document.getElementById("var" + nombre[0].toUpperCase() + nombre.slice(1));
      const validos = v.dias.filter((d) => !isNaN(d[nombre]));
      caja.replaceChildren();
      const titulo = document.createElement("h3");
      titulo.textContent = vv.nombre;
      const grande = document.createElement("p");
      grande.className = "porcentaje";
      const detalle = document.createElement("p");
      detalle.className = "detalle-variacion";
      caja.append(titulo, grande, detalle);

      if (validos.length < 2) {
        grande.textContent = "--";
        detalle.textContent = "Hacen falta al menos dos días con datos.";
        continue;
      }
      const ini = validos[0];
      const fin = validos[validos.length - 1];
      const a = ini[nombre];
      const b = fin[nombre];
      const flecha = b > a ? "▲" : b < a ? "▼" : "●";
      if (a === 0) {
        grande.textContent = "--";
        detalle.textContent = `No se puede calcular: el dato inicial es 0${vv.unidad}.`;
      } else {
        const pct = (Math.abs(a - b) / Math.abs(a)) * 100;
        grande.textContent = `${flecha} ${pct.toFixed(pct < 10 ? 2 : 1)} %`;
        detalle.textContent = `De ${fmt(a, vv.decimales)} a ${fmt(b, vv.decimales)}${vv.unidad}, del día ${formatoEntero(ini.dia)} al ${formatoEntero(fin.dia)}.`;
      }
      caja.dataset.sentido = b > a ? "sube" : b < a ? "baja" : "igual";
    }
  }

  // ---------- 6) TIEMPO EN CADA NIVEL ----------
  function barraNiveles(etiqueta, cuenta, total) {
    const fila = document.createElement("div");
    fila.className = "fila-nivel";
    const nombre = document.createElement("span");
    nombre.className = "nombre-fila";
    nombre.textContent = etiqueta;
    const barra = document.createElement("div");
    barra.className = "barra-nivel";
    barra.setAttribute("role", "img");
    const partes = [];
    for (const nivel of ["ideal", "medio", "critico"]) {
      const pct = total ? (cuenta[nivel] / total) * 100 : 0;
      partes.push(`${NOMBRE_NIVEL[nivel]} ${Math.round(pct)} %`);
      if (pct === 0) continue;
      const trozo = document.createElement("span");
      trozo.className = "z " + nivel;
      trozo.style.width = pct + "%";
      if (pct >= 12) trozo.textContent = Math.round(pct) + " %";
      barra.append(trozo);
    }
    barra.setAttribute("aria-label", `${etiqueta}: ${partes.join(", ")}`);
    barra.title = partes.join(" · ");
    fila.append(nombre, barra);
    return fila;
  }

  function pintarNiveles(v) {
    const caja = document.getElementById("nivelesTiempo");
    const filas = [];
    for (const nombre of [...nombres, "coral"]) {
      const cuenta = { ideal: 0, medio: 0, critico: 0 };
      let total = 0;
      for (const d of v.dias) {
        const nivel = nombre === "coral" ? d.nivelCoral : d.niveles[nombre];
        if (nivel) { cuenta[nivel]++; total++; }
      }
      filas.push(barraNiveles(nombre === "coral" ? "Coral (peor variable)" : VARIABLES[nombre].nombre, cuenta, total));
    }
    const leyenda = document.createElement("p");
    leyenda.className = "leyenda-niveles";
    leyenda.innerHTML = '<span class="clave ideal"></span>Ideal <span class="clave medio"></span>Medio <span class="clave critico"></span>Crítico';
    caja.replaceChildren(...filas, leyenda);
  }

  // ---------- 7) UMBRALES SUPERADOS ----------
  function rachaMasLarga(v, nombre) {
    let mejor = null;
    let actual = null;
    for (const c of v.casillas) {
      if (!c.dato) continue;
      const fuera = c.dato.niveles[nombre] && c.dato.niveles[nombre] !== "ideal";
      if (fuera) {
        if (!actual) actual = { desde: c.dato.dia, hasta: c.dato.dia, dias: 0, critico: false };
        actual.hasta = c.dato.dia;
        actual.dias++;
        if (c.dato.niveles[nombre] === "critico") actual.critico = true;
        if (!mejor || actual.dias > mejor.dias) mejor = { ...actual };
      } else {
        actual = null;
      }
    }
    return { mejor, actual };
  }

  function pintarEventos(v) {
    const caja = document.getElementById("eventosUmbral");
    const bloques = [];
    for (const nombre of nombres) {
      let eventos = 0;
      let criticos = 0;
      let fuera = 0;
      let anterior = "ideal";
      for (const d of v.dias) {
        const n = d.niveles[nombre];
        if (!n) continue;
        if (n !== "ideal") fuera++;
        if (n !== "ideal" && anterior === "ideal") eventos++;
        if (n === "critico" && anterior !== "critico") criticos++;
        anterior = n;
      }
      const { mejor, actual } = rachaMasLarga(v, nombre);
      const el = document.createElement("div");
      el.className = "evento";
      const h = document.createElement("h3");
      h.textContent = VARIABLES[nombre].nombre;
      const p1 = document.createElement("p");
      p1.textContent = eventos === 0
        ? "Nunca salió del rango ideal."
        : `Salió del rango ideal ${eventos} ${eventos === 1 ? "vez" : "veces"} (${criticos} a nivel crítico). ${fuera} de ${v.dias.length} días fuera del ideal.`;
      el.append(h, p1);
      if (mejor) {
        const p2 = document.createElement("p");
        p2.className = "secundario-texto";
        p2.textContent = `Racha más larga: ${mejor.dias} ${mejor.dias === 1 ? "día" : "días"} (día ${formatoEntero(mejor.desde)} a ${formatoEntero(mejor.hasta)})${mejor.critico ? ", con días críticos" : ""}.`;
        el.append(p2);
      }
      const ultimo = v.dias[v.dias.length - 1];
      if (actual && ultimo && actual.hasta === ultimo.dia) {
        const p3 = document.createElement("p");
        p3.className = "alerta-texto";
        p3.textContent = `Ahora mismo lleva ${actual.dias} ${actual.dias === 1 ? "día" : "días"} fuera del ideal.`;
        el.append(p3);
      }
      bloques.push(el);
    }
    caja.replaceChildren(...bloques);
  }

  // ---------- ACUARIO: EL CORAL SIGUE EL BLANQUEO ACUMULADO ----------
  function pintarAcuario(serie) {
    const ultimo = serie.dias[serie.dias.length - 1];
    if (!ultimo) return;
    const coral = document.querySelector("#tarjetaSalud .coral");
    coral.style.setProperty("--hueso", "#f4efe4");
    coral.style.setProperty("--blanqueo", ultimo.blanqueo.toFixed(3));
    document.getElementById("indiceBlanqueo").textContent =
      `Índice de blanqueo acumulado: ${Math.round(ultimo.blanqueo * 100)} % (${estadoBlanqueo(ultimo.blanqueo)}). El dibujo muestra este índice: refleja la historia del agua, no solo la última lectura.`;
  }

  // ---------- TODO JUNTO ----------
  function pintar(serie, v) {
    if (v.dias.length === 0) return;
    pintarAcuario(serie);
    pintarVariaciones(v);
    pintarBlanqueo(v);
    pintarNiveles(v);
    pintarEventos(v);
  }

  return { serieDiaria, ventana, pintar };
}
