/**
 * ============================================================================
 * CYCLOSPOT IoT CLOUD ENGINE (100% AUTOMÁTICO PELOS SENSORES DO ARDUINO)
 * ============================================================================
 * As vagas mudam para OCUPADA ou LIVRE exclusivamente quando a bicicleta para
 * na frente do sensor ultrassônico HC-SR04 no Arduino e o Arduino envia os
 * dados pelo cabo USB (via Gateway Python ou Web Serial USB direto).
 */

(function () {
  const MQTT_TOPIC = "cyclospot/italo/2026/telemetria";
  const BROKER_URLS = [
    "wss://broker.emqx.io:8084/mqtt",
    "wss://broker.hivemq.com:8884/mqtt"
  ];
  const PUBLIC_GITHUB_URL = "https://wls-djsf.github.io/cyclospot-iot/";
  const LIMITE_CM = 3; // Mesmo limite (3 cm) configurado no código do Arduino

  // Estado compartilhado em tempo real (atualizado pelos sensores físicos)
  window.CycloSpotIoT = {
    mqttConnected: false,
    arduinoConnected: false,
    arduinoPort: "Aguardando dados do sensor...",
    occupiedSlots: [],
    distances: { 1: 999, 2: 999, 3: 999 },
    activities: [],
    clients: [],
    publishState: null
  };

  // ==========================================================================
  // 1. BANCO DE DADOS EM NUVEM / NAVEGADOR PARA FUNCIONAR NO GITHUB PAGES
  // ==========================================================================
  const STORAGE_KEY_DB = "cyclospot_cloud_db_v3";

  function carregarBancoLocal() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_DB);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.bike_parks && parsed.bike_parks[0]) {
          parsed.bike_parks[0].capacity = 3;
        }
        return parsed;
      }
    } catch (_) {}
    const inicial = {
      users: [
        { id: 1, name: "Administrador", email: "admin@cyclospot.com", pass: "12345678", role: "admin", selected_bike_park_id: 1 },
        { id: 2, name: "Admin Geral", email: "admin.cyclospot@gmail.com", pass: "12345678", role: "admin", selected_bike_park_id: 1 },
        { id: 3, name: "Gustavo Brito de Jesus", email: "gustavo.315515@aluno.italo.br", pass: "12345678", role: "user", selected_bike_park_id: 1 },
        { id: 4, name: "Wanderson Lopes", email: "wanderson@cyclospot.com", pass: "12345678", role: "admin", selected_bike_park_id: 1 }
      ],
      bike_parks: [
        { id: 1, name: "CycloSpot — Unidade Piloto", address: "Bloco A - Térreo", capacity: 3, hours: "24 horas" }
      ],
      reservations: []
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
      } catch (_) {}
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

    if (pathname === "/login" && method === "POST") {
      const email = (body.email || "").toLowerCase().trim();
      const pass = body.password || "";
      let user = db.users.find(u => u.email.toLowerCase() === email);
      if (!user) {
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
      for (let n = 1; n <= 3; n++) {
        const isSensor = ocupadasSensor.has(n);
        const isRes = reservadasBanco.has(n);
        const ocupada = isSensor || isRes;
        slots.push({
          number: n,
          available: !ocupada,
          sensor_occupied: isSensor
        });
      }
      return jsonResp({ capacity: 3, slots });
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
        total: h === 8 ? confirmadas.length : 0
      }));
      const dias = ["Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado", "Domingo"];
      const by_weekday = dias.map(d => ({ day: d, total: confirmadas.length }));
      return jsonResp({
        total_reservations: confirmadas.length,
        active_reservations: confirmadas.length,
        total_users: db.users.length,
        average_per_day: confirmadas.length,
        peak_hour: confirmadas.length ? "08:00" : null,
        low_hour: confirmadas.length ? "08:00" : null,
        quiet_hours: [],
        by_hour,
        by_weekday,
        period_days: params.get("period") || "30"
      });
    }

    return jsonResp({ status: "ok" });
  }

  // ==========================================================================
  // 2. RECEPÇÃO AUTOMÁTICA DOS SENSORES VIA NUVEM MQTT (EMQX + HIVEMQ)
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

  // ==========================================================================
  // 3. LEITURA DIRETA DO CABO USB DO ARDUINO PELO NAVEGADOR (WEB SERIAL API)
  //    (Funciona mesmo sem precisar abrir o Python, direto no Chrome/Edge!)
  // ==========================================================================
  async function conectarCaboUSBArduinoDireto() {
    if (!("serial" in navigator)) {
      alert("Para ler o cabo USB direto pelo navegador, use o Google Chrome ou Microsoft Edge no computador onde o Arduino está plugado (ou abra o arquivo INICIAR_CYCLOSPOT.bat).");
      return;
    }
    try {
      const port = await navigator.serial.requestPort();
      await port.open({ baudRate: 9600 });
      window.CycloSpotIoT.arduinoConnected = true;
      window.CycloSpotIoT.arduinoPort = "Cabo USB Direto";
      atualizarBarraIoTUI();

      const decoder = new TextDecoderStream();
      port.readable.pipeTo(decoder.writable);
      const reader = decoder.readable.getReader();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          buffer += value;
          const linhas = buffer.split(/\r?\n/);
          buffer = linhas.pop() || "";
          linhas.forEach(processarLinhaSerialArduinoNoNavegador);
        }
      }
    } catch (err) {
      alert("Não foi possível abrir a porta USB: " + err.message + "\n\nVerifique se o Monitor Serial da Arduino IDE está fechado!");
    }
  }
  window.conectarCaboUSBArduinoDireto = conectarCaboUSBArduinoDireto;

  function atualizarSensorLocalETransmitir(numVaga, distCm) {
    if (![1, 2, 3].includes(numVaga)) return;
    window.CycloSpotIoT.distances[numVaga] = distCm;
    const estavaOcupada = window.CycloSpotIoT.occupiedSlots.includes(numVaga);
    const agoraOcupada = distCm > 0 && distCm <= LIMITE_CM;
    const horario = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

    let mudouEstado = false;
    if (agoraOcupada && !estavaOcupada) {
      window.CycloSpotIoT.occupiedSlots.push(numVaga);
      window.CycloSpotIoT.occupiedSlots.sort();
      window.CycloSpotIoT.activities.unshift({
        type: "entrada",
        label: `Entrada de bicicleta (Vaga 0${numVaga})`,
        time: horario
      });
      mudouEstado = true;
    } else if (!agoraOcupada && estavaOcupada) {
      window.CycloSpotIoT.occupiedSlots = window.CycloSpotIoT.occupiedSlots.filter(x => x !== numVaga);
      window.CycloSpotIoT.activities.unshift({
        type: "saida",
        label: `Saída de bicicleta (Vaga 0${numVaga})`,
        time: horario
      });
      mudouEstado = true;
    }

    window.CycloSpotIoT.activities = window.CycloSpotIoT.activities.slice(0, 6);
    const pacote = {
      source: "arduino_usb",
      connected: true,
      port: "USB Arduino",
      occupied_slots: window.CycloSpotIoT.occupiedSlots,
      distances: window.CycloSpotIoT.distances,
      activities: window.CycloSpotIoT.activities
    };
    aplicarTelemetriaRecebida(pacote);
    if (mudouEstado) {
      publicarEstadoMQTT(pacote);
    }
  }

  function processarLinhaSerialArduinoNoNavegador(linha) {
    linha = (linha || "").trim();
    if (!linha) return;

    // Formato 1: JSON {"ocupadas":1,"livres":2,"vaga1":2,"vaga2":999,"vaga3":999}
    if (linha.startsWith("{") && linha.endsWith("}")) {
      try {
        const d = JSON.parse(linha);
        [1, 2, 3].forEach(idx => {
          if (d["vaga" + idx] !== undefined) {
            atualizarSensorLocalETransmitir(idx, Number(d["vaga" + idx]));
          }
        });
        return;
      } catch (_) {}
    }

    // Formato 2: Texto do seu código Arduino -> "Vaga 1: 2 cm"
    if (linha.toLowerCase().startsWith("vaga")) {
      const partes = linha.replace(":", "").split(/\s+/);
      if (partes.length >= 3) {
        const numVaga = parseInt(partes[1], 10);
        const distCm = parseInt(partes[2], 10);
        if (!isNaN(numVaga) && !isNaN(distCm)) {
          atualizarSensorLocalETransmitir(numVaga, distCm);
        }
      }
    }
  }

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
    if (Array.isArray(dados.activities)) {
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
    if (boxAtividades) {
      const lista = window.CycloSpotIoT.activities || [];
      if (lista.length === 0) {
        boxAtividades.innerHTML =
          "<h2>Últimas atividades (Sensores)</h2>" +
          "<p style='color:#5c6b62;font-size:14px;'>Aguardando bicicleta parar no sensor ultrassônico...</p>";
      } else {
        boxAtividades.innerHTML =
          "<h2>Últimas atividades (Sensores)</h2>" +
          lista
            .slice(0, 5)
            .map(
              a =>
                `<p class="${a.type === "saida" ? "saida" : "entrada"}"><span>${a.label}</span> <span>${a.time}</span></p>`
            )
            .join("");
      }
    }

    // Atualiza as 3 vagas na grade visual (01, 02 e 03 controladas pelos sensores físicos)
    const gradeVagas = document.querySelector(".vagas");
    if (gradeVagas) {
      let itensVaga = gradeVagas.querySelectorAll(".vaga");
      if (itensVaga.length !== 3) {
        gradeVagas.innerHTML = `
          <div class="vaga vaga-livre">01</div>
          <div class="vaga vaga-livre">02</div>
          <div class="vaga vaga-livre">03</div>
        `;
        itensVaga = gradeVagas.querySelectorAll(".vaga");
      }

      [1, 2, 3].forEach(num => {
        const el = itensVaga[num - 1];
        const ocupadaSensor = window.CycloSpotIoT.occupiedSlots.includes(num);
        const dist = window.CycloSpotIoT.distances[num];
        el.className = "vaga " + (ocupadaSensor ? "ocupada-vaga" : "vaga-livre");
        el.title = ocupadaSensor
          ? `Vaga 0${num}: OCUPADA pelo sensor ultrassônico (${dist} cm)`
          : `Vaga 0${num}: LIVRE no sensor ultrassônico`;
      });

      const totalCap = 3;
      const totalOcup = gradeVagas.querySelectorAll(".ocupada-vaga").length;
      const totalDisp = totalCap - totalOcup;
      const c1 = document.querySelector(".cards .card:nth-child(1) p");
      const c2 = document.querySelector(".cards .card:nth-child(2) p");
      const s1 = document.querySelector(".cards .card:nth-child(1) span");
      const s2 = document.querySelector(".cards .card:nth-child(2) span");
      const c3 = document.querySelector(".cards .card:nth-child(3) p");
      const barra = document.querySelector(".barra-preenchida");
      if (c1) c1.textContent = totalDisp;
      if (c2) c2.textContent = totalOcup;
      if (s1) s1.textContent = "de 3 vagas";
      if (s2) s2.textContent = "de 3 vagas";
      if (c3) c3.textContent = Math.round((totalOcup / totalCap) * 100) + "%";
      if (barra) barra.style.width = (totalOcup / totalCap) * 100 + "%";
    }
  }

  // ==========================================================================
  // 4. BOTÕES MINIMALISTAS: APENAS "CONECTAR CABO USB" E "QR CODE"
  // ==========================================================================
  function injetarBarraIoT() {
    const painel = document.querySelector(".conteudo");
    if (!painel || document.getElementById("barra-iot-cloud")) return;

    const estilo = document.createElement("style");
    estilo.textContent = `
      .barra-iot-cloud {
        display: flex;
        justify-content: flex-end;
        align-items: center;
        gap: 10px;
        margin: 10px 0 14px;
      }
      .btn-usb-iot {
        background: #ffffff;
        color: #173d2b;
        border: 1px solid #cfe0d5;
        padding: 9px 15px;
        border-radius: 9px;
        font-weight: 700;
        font-size: 13.5px;
        cursor: pointer;
        transition: background 0.15s;
      }
      .btn-usb-iot:hover {
        background: #eaf5ed;
      }
      .btn-acao-iot {
        background: #176b43;
        color: #ffffff;
        border: none;
        padding: 10px 16px;
        border-radius: 9px;
        font-weight: 700;
        font-size: 13.5px;
        cursor: pointer;
        transition: background 0.15s;
      }
      .btn-acao-iot:hover {
        background: #0d5232;
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
      <button type="button" class="btn-usb-iot" id="btn-conectar-usb" style="display:none;" onclick="conectarCaboUSBArduinoDireto()">
        🔌 Conectar Cabo USB
      </button>
      <button type="button" class="btn-acao-iot" onclick="document.getElementById('modal-qr-banca').style.display='flex'">
        📱 QR Code
      </button>
    `;

    // Exibe o botão "Conectar Cabo USB" exclusivamente quando logado como Administrador
    const token = localStorage.getItem("cyclospot_token");
    if (token) {
      window.fetch("/api/me", { headers: { Authorization: "Bearer " + token } })
        .then(r => (r.ok ? r.json() : null))
        .then(me => {
          const btnUsb = document.getElementById("btn-conectar-usb");
          if (btnUsb && me && me.role === "admin") {
            btnUsb.style.display = "inline-block";
          }
        })
        .catch(() => {});
    }

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
        <h3 style="color:#0b3520; margin-bottom:4px;">Acompanhar no Celular (IoT Ao Vivo)</h3>
        <p style="font-size:13px; color:#555;">Quando a bicicleta parar no sensor da maquete, a vaga mudará automaticamente no celular:</p>
        <img src="https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(PUBLIC_GITHUB_URL)}" alt="QR Code CycloSpot IoT">
        <p style="font-size:12px; word-break:break-all; margin-bottom:14px;">
          <a href="${PUBLIC_GITHUB_URL}" target="_blank" style="color:#145334; font-weight:bold;">${PUBLIC_GITHUB_URL}</a>
        </p>
        <button type="button" class="btn-acao-iot" onclick="document.getElementById('modal-qr-banca').style.display='none'">Fechar</button>
      </div>
    `;
    document.body.appendChild(modal);
  }

  function atualizarBarraIoTUI() {
    const btnUsb = document.getElementById("btn-conectar-usb");
    if (btnUsb && window.CycloSpotIoT.arduinoConnected) {
      btnUsb.textContent = "✅ Cabo USB Conectado";
      btnUsb.style.borderColor = "#23864d";
      btnUsb.style.color = "#145334";
    }
  }

  window.addEventListener("DOMContentLoaded", () => {
    injetarBarraIoT();
    iniciarConexaoMQTT();
    setTimeout(atualizarGradeVagasDOM, 200);
  });
})();
