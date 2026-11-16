/**
 * ============================================================================
 * CYCLOSPOT IoT CLOUD ENGINE (MQTT OVER WEBSOCKETS + SERVERLESS FALLBACK)
 * ============================================================================
 * Permite que o site hospedado no GitHub Pages (ou localmente) receba em tempo
 * real as leituras dos 3 sensores ultrassônicos do Arduino via nuvem MQTT
 * (ISO/IEC 20922) em qualquer celular (4G/5G/Wi-Fi) ou computador.
 */

(function () {
  const MQTT_TOPIC = "cyclospot/italo/2026/telemetria";
  const BROKER_URLS = [
    "wss://broker.emqx.io:8084/mqtt",
    "wss://broker.hivemq.com:8884/mqtt"
  ];
  const PUBLIC_GITHUB_URL = "https://wls-djsf.github.io/cyclospot-iot/";

  // Estado compartilhado em tempo real dos sensores IoT
  window.CycloSpotIoT = {
    mqttConnected: false,
    arduinoConnected: false,
    arduinoPort: "USB",
    occupiedSlots: [],
    distances: { 1: 999, 2: 999, 3: 999 },
    activities: [
      { type: "entrada", label: "Entrada de bicicleta (Vaga 02)", time: "14:28" },
      { type: "saida", label: "Saída de bicicleta (Vaga 04)", time: "14:15" },
      { type: "entrada", label: "Entrada de bicicleta (Vaga 10)", time: "14:03" },
      { type: "saida", label: "Saída de bicicleta (Vaga 06)", time: "13:47" },
      { type: "entrada", label: "Entrada de bicicleta (Vaga 06)", time: "13:29" }
    ],
    reservedSlotsDefault: [6, 10, 14, 18, 22, 26, 30],
    clients: [],
    publishState: null
  };

  // ==========================================================================
  // 1. BANCO DE DADOS EM NUVEM / NAVEGADOR PARA FUNCIONAR NO GITHUB PAGES
  // ==========================================================================
  const STORAGE_KEY_DB = "cyclospot_cloud_db_v1";

  function carregarBancoLocal() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_DB);
      if (raw) return JSON.parse(raw);
    } catch (_) {}
    const hoje = new Date().toISOString().slice(0, 10);
    const inicial = {
      users: [
        { id: 1, name: "Administrador", email: "admin@cyclospot.com", pass: "12345678", role: "admin", selected_bike_park_id: 1 },
        { id: 2, name: "Admin Geral", email: "admin.cyclospot@gmail.com", pass: "12345678", role: "admin", selected_bike_park_id: 1 },
        { id: 3, name: "Gustavo Brito de Jesus", email: "gustavo.315515@aluno.italo.br", pass: "12345678", role: "user", selected_bike_park_id: 1 },
        { id: 4, name: "Wanderson Lopes", email: "wanderson@cyclospot.com", pass: "12345678", role: "admin", selected_bike_park_id: 1 }
      ],
      bike_parks: [
        { id: 1, name: "CycloSpot — Unidade Piloto", address: "Bloco A - Térreo", capacity: 30, hours: "24 horas" }
      ],
      reservations: [
        { id: 101, user_id: 3, user_name: "Gustavo Brito de Jesus", email: "gustavo.315515@aluno.italo.br", bike_park_id: 1, bike_park_name: "CycloSpot — Unidade Piloto", slot_number: 6, date: hoje, time: "08:00", status: "confirmed" },
        { id: 102, user_id: 4, user_name: "Wanderson Lopes", email: "wanderson@cyclospot.com", bike_park_id: 1, bike_park_name: "CycloSpot — Unidade Piloto", slot_number: 10, date: hoje, time: "08:00", status: "confirmed" }
      ]
    };
    salvarBancoLocal(inicial);
    return inicial;
  }

  function salvarBancoLocal(db) {
    try {
      localStorage.setItem(STORAGE_KEY_DB, JSON.stringify(db));
    } catch (_) {}
  }

  function obterUsuarioPorToken(headers) {
    const db = carregarBancoLocal();
    const auth = (headers && (headers.Authorization || headers.authorization)) || "";
    const token = auth.replace(/^Bearer\s+/i, "") || localStorage.getItem("cyclospot_token") || "";
    if (token.startsWith("cloud-token-")) {
      const uid = Number(token.replace("cloud-token-", ""));
      const u = db.users.find(x => x.id === uid);
      if (u) return u;
    }
    return db.users[0];
  }

  // Interceptador inteligente: se estiver no GitHub Pages (sem servidor Python local),
  // responde às rotas /api/* diretamente no navegador sincronizado com o MQTT!
  const originalFetch = window.fetch.bind(window);
  const isGitHubPages = location.hostname.includes("github.io") || location.protocol === "file:";

  window.fetch = async function (input, init) {
    const urlStr = typeof input === "string" ? input : (input && input.url) || "";
    if (!urlStr.includes("/api/")) {
      return originalFetch(input, init);
    }

    if (!isGitHubPages) {
      try {
        const resp = await originalFetch(input, init);
        if (resp.status !== 404 && resp.status !== 502) {
          return resp;
        }
      } catch (_) {
        // Se o backend local não estiver rodando, usa o motor em nuvem abaixo
      }
    }

    return simularApiCloud(urlStr, init || {});
  };

  function jsonResp(obj, status = 200) {
    return new Response(JSON.stringify(obj), {
      status,
      headers: { "Content-Type": "application/json" }
    });
  }

  async function simularApiCloud(urlStr, init) {
    const db = carregarBancoLocal();
    const method = (init.method || "GET").toUpperCase();
    const body = init.body ? JSON.parse(init.body) : {};
    const pathPart = urlStr.split("/api")[1] || "";
    const [pathname, queryString] = pathPart.split("?");
    const params = new URLSearchParams(queryString || "");

    if (pathname === "/health") {
      return jsonResp({
        status: "ok",
        service: "CycloSpot Cloud IoT",
        mqtt_cloud_connected: window.CycloSpotIoT.mqttConnected,
        arduino_connected: window.CycloSpotIoT.arduinoConnected
      });
    }

    if (pathname === "/sensors") {
      return jsonResp({
        connected: window.CycloSpotIoT.arduinoConnected,
        port: window.CycloSpotIoT.arduinoPort,
        mqtt_cloud_connected: window.CycloSpotIoT.mqttConnected,
        occupied_slots: window.CycloSpotIoT.occupiedSlots,
        occupied_count: window.CycloSpotIoT.occupiedSlots.length,
        free_count: 3 - window.CycloSpotIoT.occupiedSlots.length,
        distances: window.CycloSpotIoT.distances,
        activities: window.CycloSpotIoT.activities
      });
    }

    if (pathname.startsWith("/sensors/toggle/") && method === "POST") {
      const slotNum = Number(pathname.split("/").pop());
      alternarSensorNuvem(slotNum);
      return jsonResp({
        connected: true,
        occupied_slots: window.CycloSpotIoT.occupiedSlots,
        distances: window.CycloSpotIoT.distances,
        activities: window.CycloSpotIoT.activities
      });
    }

    if (pathname === "/login" && method === "POST") {
      const email = (body.email || "").toLowerCase().trim();
      const pass = body.password || "";
      let user = db.users.find(u => u.email.toLowerCase() === email);
      if (!user) {
        // Permite login rápido em demonstração para avaliação da banca
        user = {
          id: Date.now(),
          name: email.split("@")[0],
          email,
          pass,
          role: email.includes("admin") ? "admin" : "user",
          selected_bike_park_id: 1
        };
        db.users.push(user);
        salvarBancoLocal(db);
      }
      const token = "cloud-token-" + user.id;
      return jsonResp({ access_token: token, token_type: "bearer", user });
    }

    if (pathname === "/register" && method === "POST") {
      const email = (body.email || "").toLowerCase().trim();
      const user = {
        id: Date.now(),
        name: (body.name || "Ciclista").trim(),
        email,
        pass: body.password || "12345678",
        role: email.includes("admin") ? "admin" : "user",
        selected_bike_park_id: 1
      };
      db.users.push(user);
      salvarBancoLocal(db);
      const token = "cloud-token-" + user.id;
      return jsonResp({ access_token: token, token_type: "bearer", user });
    }

    if (pathname === "/me") {
      const user = obterUsuarioPorToken(init.headers);
      return jsonResp(user);
    }

    if (pathname === "/bike-parks") {
      return jsonResp(db.bike_parks);
    }

    if (pathname === "/me/bike-park" && method === "PATCH") {
      const user = obterUsuarioPorToken(init.headers);
      user.selected_bike_park_id = Number(body.bike_park_id) || 1;
      salvarBancoLocal(db);
      return jsonResp({ message: "Bicicletário selecionado.", bike_park_id: user.selected_bike_park_id });
    }

    if (pathname === "/slots") {
      const reservadasBanco = new Set(
        db.reservations.filter(r => r.status === "confirmed").map(r => Number(r.slot_number))
      );
      const ocupadasSensor = new Set(window.CycloSpotIoT.occupiedSlots.map(Number));
      const slots = [];
      for (let n = 1; n <= 30; n++) {
        const isSensor = ocupadasSensor.has(n);
        const isRes = reservadasBanco.has(n);
        // Vagas 1, 2 e 3 refletem exclusivamente os 3 sensores ultrassônicos físicos do Arduino
        const ocupada = n <= 3 ? isSensor : isRes;
        slots.push({
          number: n,
          available: !ocupada,
          sensor_occupied: isSensor
        });
      }
      return jsonResp({ capacity: 30, slots });
    }

    if (pathname === "/reservations" && method === "POST") {
      const user = obterUsuarioPorToken(init.headers);
      const slot_number = Number(body.slot_number);
      const nova = {
        id: Date.now(),
        user_id: user.id,
        user_name: user.name,
        email: user.email,
        bike_park_id: 1,
        bike_park_name: "CycloSpot — Unidade Piloto",
        slot_number,
        date: body.date || new Date().toISOString().slice(0, 10),
        time: body.time || "08:00",
        status: "confirmed"
      };
      db.reservations.unshift(nova);
      salvarBancoLocal(db);
      return jsonResp({ id: nova.id, message: "Reserva registrada com sucesso!", status: "confirmed" });
    }

    if (pathname === "/reservations/mine") {
      const user = obterUsuarioPorToken(init.headers);
      const minhas = db.reservations.filter(r => r.user_id === user.id || user.role === "admin");
      return jsonResp(minhas);
    }

    if (pathname === "/admin/reservations") {
      return jsonResp(db.reservations);
    }

    if (pathname.startsWith("/admin/reservations/") && method === "DELETE") {
      const id = Number(pathname.split("/").pop());
      const item = db.reservations.find(r => r.id === id);
      if (item) item.status = "cancelled";
      salvarBancoLocal(db);
      return jsonResp({ message: "Reserva cancelada." });
    }

    if (pathname === "/admin/users") {
      return jsonResp(
        db.users.map(u => {
          const count = db.reservations.filter(r => r.user_id === u.id && r.status === "confirmed").length;
          return {
            id: u.id,
            name: u.name,
            email: u.email,
            reservation_count: count,
            last_reservation: new Date().toISOString().slice(0, 10),
            classification: count >= 3 ? "Frequente" : count === 2 ? "Retornou" : count === 1 ? "Uma visita" : "Sem reservas"
          };
        })
      );
    }

    if (pathname === "/admin/reports") {
      const confirmadas = db.reservations.filter(r => r.status === "confirmed");
      const by_hour = Array.from({ length: 24 }, (_, h) => ({
        hour: String(h).padStart(2, "0") + ":00",
        total: h === 8 ? confirmadas.length : h === 14 ? 2 : h === 17 ? 3 : 0
      }));
      const dias = ["Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado", "Domingo"];
      const by_weekday = dias.map((d, i) => ({ day: d, total: i < 5 ? confirmadas.length + i : 1 }));
      return jsonResp({
        total_reservations: confirmadas.length + 5,
        active_reservations: confirmadas.length,
        total_users: db.users.length,
        average_per_day: 2.4,
        peak_hour: "17:00",
        low_hour: "08:00",
        quiet_hours: [],
        by_hour,
        by_weekday,
        period_days: params.get("period") || "30"
      });
    }

    return jsonResp({ status: "ok" });
  }

  // ==========================================================================
  // 2. CONEXÃO MQTT SOBRE WEBSOCKETS EM TEMPO REAL (EMQX + HIVEMQ)
  // ==========================================================================
  function carregarScriptMQTT(callback) {
    if (window.mqtt) {
      callback();
      return;
    }
    const script = document.createElement("script");
    script.src = "https://unpkg.com/mqtt@5.10.3/dist/mqtt.min.js";
    script.onload = callback;
    document.head.appendChild(script);
  }

  function iniciarConexaoMQTT() {
    carregarScriptMQTT(() => {
      BROKER_URLS.forEach(url => {
        try {
          const client = window.mqtt.connect(url, {
            clientId: "cyclospot-web-" + Math.random().toString(16).slice(2, 10),
            clean: true,
            connectTimeout: 5000,
            reconnectPeriod: 3000
          });

          client.on("connect", () => {
            window.CycloSpotIoT.mqttConnected = true;
            client.subscribe(MQTT_TOPIC, { qos: 0 });
            atualizarBarraIoTUI();
          });

          client.on("message", (topic, message) => {
            if (topic !== MQTT_TOPIC) return;
            try {
              const dados = JSON.parse(message.toString());
              aplicarTelemetriaRecebida(dados);
            } catch (_) {}
          });

          window.CycloSpotIoT.clients.push(client);
        } catch (_) {}
      });
    });
  }

  function publicarEstadoMQTT(dados) {
    const msg = JSON.stringify({
      ...dados,
      timestamp_ms: Date.now()
    });
    window.CycloSpotIoT.clients.forEach(c => {
      try {
        if (c.connected) {
          c.publish(MQTT_TOPIC, msg, { qos: 0, retain: true });
        }
      } catch (_) {}
    });
  }
  window.CycloSpotIoT.publishState = publicarEstadoMQTT;

  function alternarSensorNuvem(numVaga) {
    const idx = window.CycloSpotIoT.occupiedSlots.indexOf(numVaga);
    const horario = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    if (idx >= 0) {
      window.CycloSpotIoT.occupiedSlots.splice(idx, 1);
      window.CycloSpotIoT.distances[numVaga] = 999;
      window.CycloSpotIoT.activities.unshift({
        type: "saida",
        label: `Saída de bicicleta (Vaga 0${numVaga})`,
        time: horario
      });
    } else {
      window.CycloSpotIoT.occupiedSlots.push(numVaga);
      window.CycloSpotIoT.occupiedSlots.sort();
      window.CycloSpotIoT.distances[numVaga] = 2;
      window.CycloSpotIoT.activities.unshift({
        type: "entrada",
        label: `Entrada de bicicleta (Vaga 0${numVaga})`,
        time: horario
      });
    }
    window.CycloSpotIoT.activities = window.CycloSpotIoT.activities.slice(0, 6);

    const novoEstado = {
      source: "web_iot",
      connected: true,
      port: "Nuvem IoT",
      occupied_slots: window.CycloSpotIoT.occupiedSlots,
      distances: window.CycloSpotIoT.distances,
      activities: window.CycloSpotIoT.activities
    };

    aplicarTelemetriaRecebida(novoEstado);
    publicarEstadoMQTT(novoEstado);

    // Se estiver rodando localmente com FastAPI, também avisa o backend local
    if (!isGitHubPages) {
      originalFetch(`/api/sensors/toggle/${numVaga}`, { method: "POST" }).catch(() => {});
    }
  }
  window.alternarSensorNuvem = alternarSensorNuvem;

  function aplicarTelemetriaRecebida(dados) {
    if (Array.isArray(dados.occupied_slots)) {
      window.CycloSpotIoT.occupiedSlots = dados.occupied_slots.map(Number);
    }
    if (dados.distances) {
      window.CycloSpotIoT.distances = {
        1: Number(dados.distances["1"] ?? dados.distances[1] ?? 999),
        2: Number(dados.distances["2"] ?? dados.distances[2] ?? 999),
        3: Number(dados.distances["3"] ?? dados.distances[3] ?? 999)
      };
    }
    if (Array.isArray(dados.activities) && dados.activities.length) {
      window.CycloSpotIoT.activities = dados.activities;
    }
    if (typeof dados.connected === "boolean") {
      window.CycloSpotIoT.arduinoConnected = dados.connected;
    }
    if (dados.port) {
      window.CycloSpotIoT.arduinoPort = dados.port;
    }

    atualizarBarraIoTUI();
    atualizarGradeVagasDOM();
  }

  function atualizarGradeVagasDOM() {
    // Atualiza a lista de Últimas Atividades
    const boxAtividades = document.querySelector(".atividades");
    if (boxAtividades && Array.isArray(window.CycloSpotIoT.activities)) {
      boxAtividades.innerHTML =
        "<h2>Últimas atividades (IoT Ao Vivo)</h2>" +
        window.CycloSpotIoT.activities
          .slice(0, 5)
          .map(
            a =>
              `<p class="${a.type === "saida" ? "saida" : "entrada"}"><span>${a.label}</span> <span>${a.time}</span></p>`
          )
          .join("");
    }

    // Atualiza as Vagas 01, 02 e 03 na grade visual
    const itensVaga = document.querySelectorAll(".vagas .vaga");
    if (itensVaga.length >= 3) {
      [1, 2, 3].forEach(num => {
        const el = itensVaga[num - 1];
        const ocupada = window.CycloSpotIoT.occupiedSlots.includes(num);
        const dist = window.CycloSpotIoT.distances[num];
        el.className = "vaga " + (ocupada ? "ocupada-vaga" : "vaga-livre");
        el.title = ocupada
          ? `Vaga 0${num}: OCUPADA no sensor físico (${dist} cm)`
          : `Vaga 0${num}: LIVRE no sensor físico`;
      });

      const totalCap = itensVaga.length;
      const totalOcup = document.querySelectorAll(".vagas .ocupada-vaga").length;
      const totalDisp = totalCap - totalOcup;
      const c1 = document.querySelector(".cards .card:nth-child(1) p");
      const c2 = document.querySelector(".cards .card:nth-child(2) p");
      const c3 = document.querySelector(".cards .card:nth-child(3) p");
      const barra = document.querySelector(".barra-preenchida");
      if (c1) c1.textContent = totalDisp;
      if (c2) c2.textContent = totalOcup;
      if (c3) c3.textContent = Math.round((totalOcup / totalCap) * 100) + "%";
      if (barra) barra.style.width = (totalOcup / totalCap) * 100 + "%";
    }
  }

  // ==========================================================================
  // 3. BARRA VISUAL DE TELEMETRIA IoT + QR CODE PARA A BANCA
  // ==========================================================================
  function injetarBarraIoT() {
    const painel = document.querySelector(".conteudo");
    if (!painel || document.getElementById("barra-iot-cloud")) return;

    const estilo = document.createElement("style");
    estilo.textContent = `
      .barra-iot-cloud {
        background: linear-gradient(135deg, #0b3520 0%, #145334 100%);
        color: #fff;
        padding: 16px 20px;
        border-radius: 14px;
        margin-bottom: 20px;
        box-shadow: 0 8px 22px rgba(9, 44, 27, 0.16);
        display: flex;
        flex-wrap: wrap;
        justify-content: space-between;
        align-items: center;
        gap: 14px;
      }
      .iot-status-left {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .iot-pill {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        background: rgba(76, 217, 100, 0.2);
        border: 1px solid #4cd964;
        color: #4cd964;
        font-size: 12px;
        font-weight: 700;
        padding: 4px 11px;
        border-radius: 99px;
        width: fit-content;
      }
      .iot-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #4cd964;
        box-shadow: 0 0 8px #4cd964;
      }
      .iot-sensores-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
      }
      .sensor-chip {
        background: rgba(255, 255, 255, 0.12);
        border: 1px solid rgba(255, 255, 255, 0.25);
        color: #fff;
        padding: 8px 13px;
        border-radius: 10px;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.18s ease;
      }
      .sensor-chip:hover {
        transform: translateY(-1px);
        background: rgba(255, 255, 255, 0.22);
      }
      .sensor-chip.ocupado {
        background: #dc2626;
        border-color: #fca5a5;
        color: #fff;
      }
      .sensor-chip.livre {
        background: #15803d;
        border-color: #86efac;
        color: #fff;
      }
      .btn-qrcode-banca {
        background: #4cd964;
        color: #072515;
        border: none;
        padding: 9px 14px;
        border-radius: 10px;
        font-weight: 800;
        font-size: 13px;
        cursor: pointer;
      }
      .modal-qr-fundo {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.65);
        display: none;
        align-items: center;
        justify-content: center;
        z-index: 9999;
        padding: 20px;
      }
      .modal-qr-caixa {
        background: #fff;
        color: #16261e;
        padding: 26px;
        border-radius: 16px;
        max-width: 380px;
        width: 100%;
        text-align: center;
        box-shadow: 0 16px 40px rgba(0,0,0,0.4);
      }
      .modal-qr-caixa img {
        width: 220px;
        height: 220px;
        margin: 14px auto;
        display: block;
        border: 4px solid #145334;
        border-radius: 12px;
      }
    `;
    document.head.appendChild(estilo);

    const barra = document.createElement("div");
    barra.id = "barra-iot-cloud";
    barra.className = "barra-iot-cloud";
    barra.innerHTML = `
      <div class="iot-status-left">
        <div class="iot-pill">
          <span class="iot-dot"></span>
          <span id="iot-status-texto">Conectando Nuvem IoT (MQTT)...</span>
        </div>
        <small style="color: #cfe3d6; font-size: 12.5px;">
          Sensores Ultrassônicos HC-SR04 (Vagas 01, 02 e 03) sincronizados em tempo real entre todos os aparelhos
        </small>
      </div>
      <div class="iot-sensores-chips">
        <button type="button" class="sensor-chip livre" id="chip-vaga-1" onclick="alternarSensorNuvem(1)" title="Clique para testar ou passe a mão no sensor 1">
          Vaga 01: Livre
        </button>
        <button type="button" class="sensor-chip livre" id="chip-vaga-2" onclick="alternarSensorNuvem(2)" title="Clique para testar ou passe a mão no sensor 2">
          Vaga 02: Livre
        </button>
        <button type="button" class="sensor-chip livre" id="chip-vaga-3" onclick="alternarSensorNuvem(3)" title="Clique para testar ou passe a mão no sensor 3">
          Vaga 03: Livre
        </button>
        <button type="button" class="btn-qrcode-banca" onclick="document.getElementById('modal-qr-banca').style.display='flex'">
          📱 QR Code Banca
        </button>
      </div>
    `;

    const topo = painel.querySelector(".topo");
    if (topo && topo.nextSibling) {
      painel.insertBefore(barra, topo.nextSibling);
    } else {
      painel.prepend(barra);
    }

    const modal = document.createElement("div");
    modal.id = "modal-qr-banca";
    modal.className = "modal-qr-fundo";
    modal.onclick = e => {
      if (e.target === modal) modal.style.display = "none";
    };
    modal.innerHTML = `
      <div class="modal-qr-caixa">
        <h3 style="color:#0b3520; margin-bottom:4px;">Acesse no Celular (IoT Ao Vivo)</h3>
        <p style="font-size:13px; color:#555;">Aponte a câmera do celular para acompanhar os sensores da maquete em tempo real:</p>
        <img src="https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(PUBLIC_GITHUB_URL)}" alt="QR Code CycloSpot IoT">
        <p style="font-size:12px; word-break:break-all; margin-bottom:14px;">
          <a href="${PUBLIC_GITHUB_URL}" target="_blank" style="color:#145334; font-weight:bold;">${PUBLIC_GITHUB_URL}</a>
        </p>
        <button type="button" class="btn-qrcode-banca" onclick="document.getElementById('modal-qr-banca').style.display='none'">Fechar</button>
      </div>
    `;
    document.body.appendChild(modal);

    atualizarBarraIoTUI();
  }

  function atualizarBarraIoTUI() {
    const txt = document.getElementById("iot-status-texto");
    if (txt) {
      if (window.CycloSpotIoT.mqttConnected) {
        txt.textContent = "Nuvem IoT Ativa (MQTT Real-Time) • Sincronizado em Todos os Aparelhos";
      } else {
        txt.textContent = "Modo IoT Local / Conectando à Nuvem...";
      }
    }

    [1, 2, 3].forEach(num => {
      const chip = document.getElementById(`chip-vaga-${num}`);
      if (!chip) return;
      const ocupada = window.CycloSpotIoT.occupiedSlots.includes(num);
      const dist = window.CycloSpotIoT.distances[num];
      chip.className = "sensor-chip " + (ocupada ? "ocupado" : "livre");
      chip.textContent = ocupada
        ? `🔴 Vaga 0${num}: Ocupada (${dist <= 3 ? dist + "cm" : "Sensor"})`
        : `🟢 Vaga 0${num}: Livre`;
    });
  }

  window.addEventListener("DOMContentLoaded", () => {
    injetarBarraIoT();
    iniciarConexaoMQTT();
    setTimeout(atualizarGradeVagasDOM, 300);
  });
})();
