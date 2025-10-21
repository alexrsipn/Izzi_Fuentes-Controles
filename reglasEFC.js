// Clase ValidationManager: Maneja la carga y procesamiento de configuraciones
class ValidationManager {
  constructor() {
    // Configuración cargada desde Metadata API
    this.rulesConfig = [];
    // Lista única de XI_SAP_ID válidos
    this.sapIdList = [];
    // Credenciales para acceder a la API de OFSC
    this.credentials = null;
    // Almacenar elementos ya evaluados
    this.evaluatedItems = new Set();
    // Almacenar elementos usados
    this.usedItems = new Set();
    // Almacenar los errores de validación
    this.errors = [];
    // Almacenar fuentes y controles usados bajo la regla '*'
    this.usedWildcardSources = new Set();
    this.usedWildcardControls = new Set();
    this.equipmentDescriptionsCache = {};
  }

  // Método para establecer credenciales
  setCredentials(credentials) {
    this.credentials = credentials;
  }

  // Método interno para realizar peticiones a la API de OFSC
  async _fetchFromApi(endpoint) {
    if (!this.credentials) {
      throw new Error(
        "Credenciales no establecidas. Use setCredentials antes de hacer peticiones."
      );
    }

    // Concatenar credenciales en formato adecuado
    var urlInstance = this.credentials.urlOFSC
      .replace("https://", "")
      .split(".fs.ocs.oraclecloud.com")[0];
    var credentialsStr =
      this.credentials.ofscRestClientId +
      ":" +
      this.credentials.ofscRestSecretId;

    // Codificar en base64
    var encodedCredentials = window.btoa(credentialsStr);

    const { urlOFSC } = this.credentials;

    // console.log(urlOFSC);

    try {
      const response = await fetch(
        `${urlOFSC}/rest/ofscMetadata/v1/${endpoint}`,
        {
          method: "GET",
          headers: {
            Authorization: `Basic ${encodedCredentials}`,
            Accept: "application/json",
          },
        }
      );

      if (!response.ok) {
        throw new Error(
          `Error en la petición: ${response.status} - ${response.statusText}`
        );
      }

      return await response.json();
    } catch (error) {
      console.error("Error al realizar la petición a la API de OFSC:", error);
      throw error;
    }
  }

  // Método para cargar configuraciones desde la API de Metadata
  async loadRulesConfig() {
    try {
      // console.log('Cargando configuraciones desde Metadata API...');

      // Llamada interna al método de fetch
      const response = await this._fetchFromApi(
        "properties/XA_REGLAS_EQ_FUENTE_CONTROL"
      );

      // Procesar la respuesta JSON con códigos de escape
      const rawConfig = JSON.parse(
        response.transformation.xslt.replace(/\\"/g, '"')
      );

      // Validar que el resultado sea un array
      if (Array.isArray(rawConfig)) {
        this.rulesConfig = rawConfig;
        console.log("Configuración cargada correctamente:", this.rulesConfig);
      } else {
        console.error(
          "El formato de la configuración no es válido:",
          rawConfig
        );
      }
    } catch (error) {
      console.error(
        "Error al cargar la configuración de reglas desde Metadata API:",
        error
      );
    }
  }

  // Método para generar sapIdList eliminando duplicados
  generateSapIdList() {
    try {
      // console.log('Generando lista única de XI_EQUIPMENTTYPE y XI_MATERIALTYPE...');

      // Extraer valores de los campos XI_EQUIPMENTTYPE (equipos) y XI_MATERIALTYPE (fuentes y controles)
      const allEquipmentTypes = this.rulesConfig.map((rule) => rule.skuequipo);
      // const allMaterialTypes = [
      //     ...this.rulesConfig.map(rule => rule.skufuente),
      //     ...this.rulesConfig.map(rule => rule.skucontrol)
      // ];
      const allMaterialTypes = this.rulesConfig.flatMap((rule) => [
        ...(rule.fuentes || []),
        ...(rule.controles || []),
      ]);

      // Filtrar y eliminar duplicados, excluyendo '*' y '0'
      // this.sapIdList = [
      //     ...new Set(allEquipmentTypes.filter(id => id !== '*' && id !== '0')),
      //     ...new Set(allMaterialTypes.filter(id => id !== '*' && id !== '0'))
      // ];
      this.sapIdList = [
        ...new Set(
          allEquipmentTypes.filter(
            (id) => id !== "*" && id !== "0" && id !== "NA"
          )
        ),
        ...new Set(
          allMaterialTypes.filter(
            (id) => id !== "*" && id !== "0" && id !== "NA"
          )
        ),
      ];

      // console.log('Lista única de XI_EQUIPMENTTYPE y XI_MATERIALTYPE generada:', this.sapIdList);
    } catch (error) {
      console.error("Error al generar sapIdList:", error);
    }
  }

  // Método actualizado para filtrar inventarios por tipo y replicar fuentes según su cantidad
  filterInventoryByType(inventoryList, typeSapIds, type) {
    return inventoryList.flatMap((item, index) => {
      // Determinar la propiedad a evaluar según el tipo
      let typeProperty =
        type === "equipo" ? "XI_EQUIPMENTTYPE" : "XI_MATERIALTYPE";

      // 💡 Verificamos si el SKU o tipo del item está dentro de los permitidos según las reglas
      if (typeSapIds.includes(item[typeProperty])) {
        // 🔧 CASO 1: FUENTE (lógica original, sin cambios)
        if (type === "fuente") {
          const quantity = item.quantity || 1;
          return Array.from({ length: quantity }, (_, i) => ({
            ...item,
            uniqueId: `${item[typeProperty]}-${index}-${i}`, // identificador único por réplica
          }));
        }

        // 🔧 CASO 2: CONTROL (ajuste principal)
        if (type === "control") {
          // 💡 Detectamos si el control tiene número de serie o no
          const hasSerial = !!item.serialNumber;

          if (hasSerial) {
            // 🟢 Controles con número de serie: se mantienen únicos (comportamiento anterior)
            return [
              {
                ...item,
                uniqueId: `${item[typeProperty]}-${item.serialNumber || index}`,
              },
            ];
          } else {
            // 🟠 Controles sin número de serie: se comportan como fuentes → se multiplican por "quantity"
            const quantity = item.quantity || 1;
            return Array.from({ length: quantity }, (_, i) => ({
              ...item,
              uniqueId: `${item[typeProperty]}-${index}-${i}`, // ID único por réplica
              // 💬 Ajuste añadido: reflejamos explícitamente que es un control replicado
              replicatedFrom: "control",
            }));
          }
        }

        // ⚙️ CASO 3: EQUIPO (sin cambios)
        return [
          {
            ...item,
            uniqueId: `${item[typeProperty]}-${index}`,
          },
        ];
      }

      // 🚫 Si el SKU no está en las reglas, se descarta
      return [];
    });
  }

  // Método para marcar elementos como usados
  markAsUsed(item, isWildcard = false, type = "") {
    this.usedItems.add(item.uniqueId);
    if (isWildcard) {
      if (type === "fuente") {
        this.usedWildcardSources.add(item.uniqueId);
      } else if (type === "control") {
        this.usedWildcardControls.add(item.uniqueId);
      }
    }
  }

  // Método para verificar si un elemento ya fue usado
  isUsed(item) {
    return this.usedItems.has(item.uniqueId);
  }

  // Método para detectar elementos sobrantes
  detectUnusedItems(inventoryList) {
    return inventoryList.filter((item) => !this.isUsed(item)); // Verifica por uniqueId
  }

  //Validar combinación de equipo, fuente y control de acuerdo a las reglas de configuración
  validateCombination(
    equipment,
    sources,
    controls,
    registra_error,
    valida_e_fyoc_solos,
    validatedItems
  ) {
    // let reglasAplicables = this.rulesConfig.filter(rule => rule.skuequipo === equipment.XI_EQUIPMENTTYPE);
    const applicableRule = this.rulesConfig.find(
      (rule) => rule.skuequipo === equipment.XI_EQUIPMENTTYPE
    );

    if (!applicableRule) {
      return true; // Si no hay reglas aplicables, se considera válido por omisión
    }

    // **Conjuntos de fuentes y controles permitidos por todas las reglas del equipo**
    // let fuentesValidas = new Set();
    // let controlesValidos = new Set();
    let fuentesValidas = new Set(
      applicableRule.fuentes.filter((f) => f !== "0" && f !== "NA")
    );
    let controlesValidos = new Set(
      applicableRule.controles.filter((c) => c !== "0" && c !== "NA")
    );

    // reglasAplicables.forEach(rule => {
    //     if (rule.skufuente !== '*') fuentesValidas.add(rule.skufuente);
    //     if (rule.skucontrol !== '*' && rule.skucontrol !== '0') controlesValidos.add(rule.skucontrol);
    // });

    // **Listar fuentes y controles disponibles**
    const availableSources = sources.filter((src) => !this.isUsed(src));
    const availableControls = controls.filter((ctrl) => !this.isUsed(ctrl));

    // **Intentar validación exacta**
    // for (const rule of reglasAplicables) {
    //     // Encontrar la fuente y el control válidos según la regla
    //     let validSource = rule.skufuente === '0' ? null : availableSources.find(src => src.XI_MATERIALTYPE === rule.skufuente);
    //     // Si la regla es "0", no se necesita control
    //     let validControl = rule.skucontrol === '0' ? null : availableControls.find(ctrl => ctrl.XI_MATERIALTYPE === rule.skucontrol);

    //     if (validSource && validControl) {
    //         this.markAsUsed(equipment);
    //         this.markAsUsed(validSource, false, 'fuente');
    //         this.markAsUsed(validControl, false, 'control');

    //         // ✅ Guardar la combinación exitosa en un solo push
    //         validatedItems.push({
    //             equipo: equipment,
    //             fuente: validSource,
    //             control: validControl,
    //             resultado: true
    //         });

    //         return true;
    //     } else if (validSource && rule.skucontrol === '0') {
    //         this.markAsUsed(equipment);
    //         this.markAsUsed(validSource, false, 'fuente');

    //         // ✅ Guardar la combinación equipo-fuente
    //         validatedItems.push({
    //             equipo: equipment,
    //             fuente: validSource,
    //             control: null,
    //             resultado: true
    //         });

    //         return true;
    //     } else if (validControl && rule.skufuente === '0') {
    //         this.markAsUsed(equipment);
    //         this.markAsUsed(validControl, false, 'control');

    //         // ✅ Guardar la combinación equipo-control
    //         validatedItems.push({
    //             equipo: equipment,
    //             fuente: null,
    //             control: validControl,
    //             resultado: true
    //         });

    //         return true;
    //     }

    // }

    // **Intentar validación combinada (Equipo + Fuente + Control)**
    for (const source of availableSources) {
      for (const control of availableControls) {
        if (
          fuentesValidas.has(source.XI_MATERIALTYPE) &&
          controlesValidos.has(control.XI_MATERIALTYPE)
        ) {
          this.markAsUsed(equipment);
          this.markAsUsed(source, false, "fuente");
          this.markAsUsed(control, false, "control");
          validatedItems.push({
            equipo: equipment,
            fuente: source,
            control: control,
            resultado: true,
          });
          return true;
        }
      }
    }

    // **Validación para equipos que no requieren control**
    if (
      applicableRule.controles.includes("0") ||
      applicableRule.controles.includes("NA")
    ) {
      for (const source of availableSources) {
        if (fuentesValidas.has(source.XI_MATERIALTYPE)) {
          this.markAsUsed(equipment);
          this.markAsUsed(source, false, "fuente");
          validatedItems.push({
            equipo: equipment,
            fuente: source,
            control: null,
            resultado: true,
          });
          return true;
        }
      }
    }

    // **Validación para equipos que no requieren fuente**
    if (
      applicableRule.fuentes.includes("0") ||
      applicableRule.fuentes.includes("NA")
    ) {
      for (const control of availableControls) {
        if (controlesValidos.has(control.XI_MATERIALTYPE)) {
          this.markAsUsed(equipment);
          this.markAsUsed(control, false, "control");
          validatedItems.push({
            equipo: equipment,
            fuente: null,
            control: control,
            resultado: true,
          });
          return true;
        }
      }
    }

    // const noNecesitaFuente = applicableRule.fuentes.includes("NA");
    // const noNecesitaControl = applicableRule.controles.includes("NA");

    // if (noNecesitaControl) {
    //   this.markAsUsed(equipment);
    //   // validatedItems.push({
    //   //   equipo: equipment,
    //   //   fuente: null,
    //   //   control: null,
    //   //   resultado: true,
    //   // });
    //   return true;
    // }

    if (valida_e_fyoc_solos) {
      // **Intentar validación solo de fuentes**
      for (const source of availableSources) {
        if (fuentesValidas.has(source.XI_MATERIALTYPE)) {
          this.markAsUsed(equipment);
          this.markAsUsed(source, false, "fuente");
          validatedItems.push({
            equipo: equipment,
            fuente: source,
            control: null,
            resultado: true,
          });
          return true;
        }
      }

      // **Intentar validación solo de controles**
      for (const control of availableControls) {
        if (controlesValidos.has(control.XI_MATERIALTYPE)) {
          this.markAsUsed(equipment);
          this.markAsUsed(control, false, "control");
          validatedItems.push({
            equipo: equipment,
            fuente: null,
            control: control,
            resultado: true,
          });
          return true;
        }
      }
    }

    // **Si no hay combinación válida y se indica en la llamada se marca error**
    if (registra_error) {
      this.errors.push(
        `❌ Para el equipo con SKU ${equipment.XI_EQUIPMENTTYPE} (Serie ${equipment.serialNumber}) no se encontró una combinación válida de fuente y/o control según las reglas.`
      );
    }

    return false;
  }

  // Método para validar una lista completa de inventario
  validateInventory(inventarioInstalado, inventarioCliente) {
    // Reiniciar elementos usados al inicio
    this.usedItems.clear();
    this.errors = []; // Reiniciar los errores

    const validatedItems = [];

    const allowedEquipment = this.rulesConfig.map((rule) => rule.skuequipo);
    const allowedSources = this.rulesConfig.flatMap((rule) => rule.fuentes);
    const allowedControls = this.rulesConfig.flatMap((rule) => rule.controles);

    // PARTE 1: Validar usando inventarios instalados
    let equipments = this.filterInventoryByType(
      inventarioInstalado,
      allowedEquipment,
      "equipo"
    );
    let sources = this.filterInventoryByType(
      inventarioInstalado,
      allowedSources,
      "fuente"
    );
    let controls = this.filterInventoryByType(
      inventarioInstalado,
      allowedControls,
      "control"
    );

    for (const equipment of equipments) {
      if (!this.isUsed(equipment)) {
        const isValid = this.validateCombination(
          equipment,
          sources,
          controls,
          false,
          false,
          validatedItems
        );
        if (!isValid) {
          // 🔹 Ajustado al nuevo formato (serie + SKU)
          this.errors.push(
            `❌ Al equipo con SKU ${equipment.XI_EQUIPMENTTYPE} (Serie ${equipment.serialNumber}) le falta fuente y/o control compatible.`
          );
        }
      }
    }

    // Guardar fuentes y controles que no fueron usados
    let remainingSources = sources.filter(
      (src) => !this.isUsed(src) && !this.usedWildcardSources.has(src.uniqueId)
    );
    let remainingControls = controls.filter(
      (ctrl) =>
        !this.isUsed(ctrl) && !this.usedWildcardControls.has(ctrl.uniqueId)
    );
    console.log(
      "Fuentes sobrantes después de validar con inventarios instalados:",
      remainingSources
    );
    console.log(
      "Controles sobrantes después de validar con inventarios instalados:",
      remainingControls
    );

    // PARTE 2: Validar usando inventarios de cliente
    equipments = this.filterInventoryByType(
      inventarioCliente,
      allowedEquipment,
      "equipo"
    );
    sources = this.filterInventoryByType(
      inventarioInstalado,
      allowedSources,
      "fuente"
    );
    controls = this.filterInventoryByType(
      inventarioInstalado,
      allowedControls,
      "control"
    );

    for (const equipment of equipments) {
      if (!this.isUsed(equipment)) {
        this.validateCombination(
          equipment,
          sources,
          controls,
          false,
          true,
          validatedItems
        );
      }
    }

    // Identificar fuentes y controles sobrantes después de validar con inventarios de cliente
    remainingSources = sources.filter(
      (src) => !this.isUsed(src) && !this.usedWildcardSources.has(src.uniqueId)
    );
    remainingControls = controls.filter(
      (ctrl) =>
        !this.isUsed(ctrl) && !this.usedWildcardControls.has(ctrl.uniqueId)
    );

    // Si después de validar con equipos de cliente hay fuentes o controles sobrantes, se marcan como error
    remainingSources.forEach((item) => {
      this.errors.push(
        `❌ La fuente de poder con SKU ${item.XI_MATERIALTYPE} no acompaña a algún equipo`
      );
    });

    remainingControls.forEach((item) => {
      this.errors.push(
        `❌ El control remoto con SKU ${item.XI_MATERIALTYPE} no acompaña a algún equipo`
      );
    });

    return { validatedItems, errors: [...this.errors] };
  }

  // Método para exponer resultados detallados de la validación
  getValidationResults() {
    return {
      validatedItems: [...this.usedItems], // Elementos utilizados correctamente
      errors: [...this.errors], // Mensajes de error
    };
  }

  // MÉTODO NUEVO: Obtener inventarios instalados desde la API
  async fetchInstalledInventories(activityId) {
    if (!this.credentials) {
      throw new Error(
        "Credenciales no establecidas. Use setCredentials antes de hacer peticiones."
      );
    }

    // Concatenar credenciales en formato adecuado
    var urlInstance = this.credentials.urlOFSC
      .replace("https://", "")
      .split(".fs.ocs.oraclecloud.com")[0];
    var credentialsStr =
      this.credentials.ofscRestClientId +
      ":" +
      this.credentials.ofscRestSecretId;

    // Codificar en base64
    var encodedCredentials = window.btoa(credentialsStr);

    const { urlOFSC } = this.credentials;

    try {
      const response = await fetch(
        `${urlOFSC}/rest/ofscCore/v1/activities/${activityId}/installedInventories`,
        {
          method: "GET",
          headers: {
            Authorization: `Basic ${encodedCredentials}`,
            Accept: "application/json",
          },
        }
      );

      if (!response.ok) {
        throw new Error(
          `Error al obtener inventarios instalados: ${response.status} - ${response.statusText}`
        );
      }

      const data = await response.json();
      console.log("Inventarios instalados obtenidos:", data.items);
      return data.items || [];
    } catch (error) {
      console.error(
        "Error al obtener los inventarios instalados desde la API:",
        error
      );
      throw error;
    }
  }

  // MÉTODO NUEVO: Obtener inventarios instalados desde la API
  async fetchCustomerInventories(activityId) {
    if (!this.credentials) {
      throw new Error(
        "Credenciales no establecidas. Use setCredentials antes de hacer peticiones."
      );
    }

    // Construir la autenticación en base64
    var urlInstance = this.credentials.urlOFSC
      .replace("https://", "")
      .split(".fs.ocs.oraclecloud.com")[0];
    var credentialsStr =
      this.credentials.ofscRestClientId +
      ":" +
      this.credentials.ofscRestSecretId;
    var encodedCredentials = window.btoa(credentialsStr);
    const { urlOFSC } = this.credentials;

    try {
      const response = await fetch(
        `${urlOFSC}/rest/ofscCore/v1/activities/${activityId}/customerInventories`,
        {
          method: "GET",
          headers: {
            Authorization: `Basic ${encodedCredentials}`,
            Accept: "application/json",
          },
        }
      );

      if (!response.ok) {
        throw new Error(
          `Error al obtener los inventarios de cliente: ${response.status} - ${response.statusText}`
        );
      }

      const data = await response.json();
      // console.log('Inventarios de cliente obtenidos:', data.items);
      return data.items || [];
    } catch (error) {
      console.error(
        "Error al obtener los inventarios de cliente desde la API:",
        error
      );
      return [];
    }
  }

  async preloadEquipmentDescriptions() {
    if (Object.keys(this.equipmentDescriptionsCache).length > 0) {
      return;
    }

    let offset = 0;
    let hasMore = true;
    const limit = 100;

    while (hasMore) {
      try {
        const response = await this._fetchFromApi(`properties/XI_EQUIPMENTTYPE/enumerationList?limit=${limit}&offset=${offset}`);
        if (response.items && Array.isArray(response.items)) {
          response.items.forEach((item) => {
            if (item.label && item.translations && item.translations.length > 0) {
              this.equipmentDescriptionsCache[item.label] = 
                item.translations.find((t) => t.language === "es")?.name ||
                item.translations.find((t) => t.language === "en")?.name ||
                item.label;
            }
          });
        }
        hasMore = response.hasMore || false;
        offset += limit;
      } catch (error) {
        console.error("Error al precargar descripciones de equipos:", error);
        hasMore = false;
    }
  }
  }

  getDescriptionsFromCache (equipmentType) {
    if (!equipmentType) return "Desconocido";

    return this.equipmentDescriptionsCache[equipmentType] || "Desconocido";
  }

  // Función para obtener la descripción de un equipmentType
  async consultarDescripcion(equipmentType) {
    // Diccionario para almacenar las descripciones en caché y evitar llamadas innecesarias
    //let equipmentDescriptionsCache = {};

    if (!equipmentType) return "Desconocido";

    // Si la descripción ya está en caché, devolverla
    if (this.equipmentDescriptionsCache[equipmentType]) {
      return this.equipmentDescriptionsCache[equipmentType];
    }

    try {
      // Obtener instancia de la URL
      var urlInstance = this.credentials.urlOFSC
        .replace("https://", "")
        .split(".fs.ocs.oraclecloud.com")[0];
      const ofscHelper = new OFSCRequestHelper(
        urlInstance,
        "Operación exitosa",
        "Error en la operación"
      );
      ofscHelper.setCredentials(
        this.credentials.ofscRestClientId,
        this.credentials.ofscRestSecretId
      );

      // Consultar la API de OFSC
      const response = await ofscHelper.request(
        "GET",
        `ofscMetadata/v1/properties/XI_EQUIPMENTTYPE/enumerationList`
      );

      if (response.items && Array.isArray(response.items)) {
        response.items.forEach((item) => {
          if (item.label && item.translations && item.translations.length > 0) {
            // Guardar en caché la traducción en español o inglés si no existe en español
            this.equipmentDescriptionsCache[item.label] =
              item.translations.find((t) => t.language === "es")?.name ||
              item.translations.find((t) => t.language === "en")?.name ||
              "Desconocido";
          }
        });

        // Devolver la descripción del equipo consultado
        return this.equipmentDescriptionsCache[equipmentType] || "Desconocido";
      }
    } catch (error) {
      console.error("Error al obtener la descripción del equipo:", error);
    }

    return "Desconocido";
  }
}

class OFSCRequestHelper {
  constructor(
    instance = "",
    successMessage = "Operación exitosa",
    failureMessage = "Error en la operación"
  ) {
    if (!instance) {
      throw new Error("Debe especificarse la instancia de OFSC.");
    }
    this.instance = instance;
    this.credentials = null;
    this.successMessage = successMessage;
    this.failureMessage = failureMessage;
  }

  setCredentials(clientId, secretId) {
    if (!clientId || !secretId) {
      throw new Error(
        "clientId y secretId son requeridos para configurar credenciales."
      );
    }
    let credentialsStr = `${clientId}:${secretId}`;
    this.encodedCredentials = window.btoa(credentialsStr);
  }

  async request(method, endpoint, body = null) {
    if (!this.encodedCredentials) {
      throw new Error(
        "Credenciales no establecidas. Use setCredentials antes de hacer peticiones."
      );
    }
    if (!method || !endpoint) {
      throw new Error("El método HTTP y el endpoint son requeridos.");
    }

    const url = `https://${this.instance}.fs.ocs.oraclecloud.com/rest/${endpoint}`;

    const options = {
      method: method.toUpperCase(),
      headers: {
        Authorization: `Basic ${this.encodedCredentials}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    };

    if (body && (method === "POST" || method === "PATCH")) {
      options.body = JSON.stringify(body);
    }
    console.log(`ENDPOINT TOTAL:${url}`);

    try {
      const response = await fetch(url, options);

      if (!response.ok) {
        throw new Error(
          `${this.failureMessage}: ${response.status} - ${response.statusText}`
        );
      }

      const data = await response.json();
      console.log(`${this.successMessage}:`, data);
      return data;
    } catch (error) {
      console.error(`${this.failureMessage}:`, error);
      throw error;
    }
  }
}

class ContoladorReglasEFC {
  constructor(pluginInstance) {
    this.plugin = pluginInstance;
    this.installedInventories = [];
    this.customerInventories = [];
    this.validationManager = new ValidationManager();
    this.flujoAprov = false; // Indica si está en el flujo de aprovisionamiento
  }

  async ejecutarValidacionEFC(receivedData) {
    const { valid, errors } = await this.validacEquiposFuenteControles(
      receivedData
    );

    if (errors.length > 0) {
      if (this.flujoAprov) {
        this.mostrarModalErrores(valid, errors);
      }
      return false; // 🚫 Si hay errores, detener ejecución
    }

    console.log("✅ Validación exitosa, continuando con el flujo...");
    return true;
  }

  async mostrarModalErrores(valid, errors) {
    let modalHtml = `
            <div id="errorModal" class="modal">
                <div class="modal-content">
                    <h2>Resultados de Validación</h2>
                    <table border="1">
                        <thead>
                            <tr>
                                <th>#</th>
                                <th>Tipo</th>
                                <th>Identificador</th>
                                <th>Descripción</th>
                                <th>Fuentes Asociadas</th>
                                <th>Controles Asociados</th>
                                <th>Resultado</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${valid
                              .map(
                                (item, index) => `
                                <tr>
                                    <td>${index + 1}</td>
                                    <td>${
                                      item.equipo ? "Equipo" : "Fuente/Control"
                                    }</td>
                                    <td>${
                                      item.equipo?.XI_EQUIPMENTTYPE ||
                                      item.fuente?.XI_MATERIALTYPE ||
                                      item.control?.XI_MATERIALTYPE ||
                                      "Desconocido"
                                    }</td>
                                    <td>${item.descripcion || "N/A"}</td>
                                    <td>${
                                      item.fuente
                                        ? item.fuente.XI_MATERIALTYPE
                                        : "-"
                                    }</td>
                                    <td>${
                                      item.control
                                        ? item.control.XI_MATERIALTYPE
                                        : "-"
                                    }</td>
                                    <td style="color:${
                                      item.resultado ? "green" : "red"
                                    };">${
                                  item.resultado ? "✅ Válido" : "❌ Inválido"
                                }</td>
                                </tr>
                            `
                              )
                              .join("")}
                        </tbody>
                    </table>
                    <h3 style="color:red;">Errores:</h3>
                    <ul>
                        ${errors.map((error) => `<li>${error}</li>`).join("")}
                    </ul>
                    <button id="cerrarModal">Cerrar</button>
                </div>
            </div>
        `;

    $("body").append(modalHtml);
    $("#errorModal").show();
    $("#cerrarModal").on("click", function () {
      $("#errorModal").remove();
    });
  }

  async validacEquiposFuenteControles(receivedData) {
    // console.log(
    //   "Iniciando validación de Equipos, Fuentes y Controles desde Mac"
    // );
    let fullUrl = receivedData.securedData.urlOFSC;
    let urlBaseMatch = fullUrl.match(/^https?:\/\/[^\/]+\.com\//);
    let urlBase = urlBaseMatch ? urlBaseMatch[0] : fullUrl;

    // if (!urlBase.includes("ofscCore")) {
    //   urlBase = urlBase.replace(/\/$/, "");
    //   this.flujoAprov = false;
    // }

    const credentialsValidador = {
      ofscRestClientId: receivedData.securedData.ofscRestClientId,
      ofscRestSecretId: receivedData.securedData.ofscRestSecretId,
      urlOFSC: urlBase,
    };

    this.validationManager.setCredentials(credentialsValidador);
    await this.validationManager.loadRulesConfig();
    this.validationManager.generateSapIdList();

    await this.validationManager.preloadEquipmentDescriptions();

    this.installedInventories =
      await this.validationManager.fetchInstalledInventories(this.plugin.aid);
    this.customerInventories =
      await this.validationManager.fetchCustomerInventories(this.plugin.aid);

    return this.validateAndFilterInventory(
      this.installedInventories,
      this.customerInventories
    );
  }

  validateAndFilterInventory(installedInventories, customerInventories) {
    // console.log('Validando inventarios instalados...');
    const validationResults = this.validationManager.validateInventory(
      installedInventories,
      customerInventories
    );
    this.installedInventories = validationResults.validatedItems;
    const errores = validationResults.errors;

    console.log(
      "Colección de inventarios instalados válidos:",
      this.installedInventories
    );
    console.log("Errores encontrados:", errores);
    if (!this.flujoAprov) {
      this.populateInventoryTable(this.installedInventories, errores);
    }
    return { valid: this.installedInventories, errors: errores };
  }

  async populateInventoryTable(inventoryData, errors) {
    let tableBody = $("#inventoryTable tbody");
    tableBody.empty();
    console.log("Poblando tabla con datos de inventario:", inventoryData);

    for (let index = 0; index < inventoryData.length; index++) {
      let item = inventoryData[index];
      let tipoElemento = item.equipo ? "Equipo" : "Fuente/Control";
      let identificador = "Desconocido";
    //   let descripcion = "Desconocido";

      if (item.equipo) {
        identificador =
          item.equipo.XI_EQUIPMENTTYPE ||
          "Desconocido";
        // descripcion = await this.validationManager.consultarDescripcion(
        //   item.equipo.XI_EQUIPMENTTYPE
        // );
      } else if (item.fuente || item.control) {
        identificador = item.fuente
          ? item.fuente.XI_MATERIALTYPE
          : item.control.XI_MATERIALTYPE;
        // descripcion = await this.validationManager.consultarDescripcion(
        //   identificador
        // );
      }

      let fuentesAsociadas = item.fuente
        ? Array.isArray(item.fuente)
          ? item.fuente.map((f) => f.XI_MATERIALTYPE).join(", ")
          : item.fuente.XI_MATERIALTYPE
        : "-";
      let controlesAsociados = item.control
        ? Array.isArray(item.control)
          ? item.control.map((c) => c.XI_MATERIALTYPE).join(", ")
          : item.control.XI_MATERIALTYPE
        : "-";
      let resultado = item.resultado ? "✅ Válido" : "Pendiente";

      const tipoEquipoDesc = item.equipo ? item.equipo.XI_EQUIPMENTTYPE : identificador;
      const descripcion = this.validationManager.getDescriptionsFromCache(tipoEquipoDesc);

      let row = "";
      if (item.equipo) {
        row = `<tr data-id="${item.equipo.inventoryId || "N/A"}">
                    <td>${index + 1}</td>
                    <td>${identificador} - ${descripcion}</td>
                    <td>${fuentesAsociadas}</td>
                    <td>${controlesAsociados}</td>
                    <td class="result">${resultado}</td>
                </tr>`;
        tableBody.append(row);
      }
    }

    // 📌 Sección de errores con mejor presentación
    if (errors.length > 0) {
      let errorSection = `<tr><td colspan="7" style="color: red; text-align: center; font-weight: bold;">⚠ Errores detectados:</td></tr>`;
      tableBody.append(errorSection);

      errors.forEach((error) => {
        let errorMsgRow = `<tr><td colspan="7" style="color: red;">${error}</td></tr>`;
        tableBody.append(errorMsgRow);
      });
    } else {
      // 📌 Determinar si se evaluaron fuentes o controles
      const evaluados = inventoryData.some(
        (item) => item.fuente || item.control
      );

      let mensaje = evaluados
        ? "✅ No se encontraron errores."
        : "⚠ No hay fuentes o controles instalados.";

      //alert(evaluados);
      let msgRow = "";
      if (!evaluados) {
        msgRow = `<tr><td colspan="7" style="text-align: center; font-weight: bold;">${mensaje}</td>`;
        msgRow =
          msgRow +
          `<tr><td colspan="7" style="text-align: center; font-weight: bold;">✅ No se encontraron errores.</td></tr>`;
      } else {
        msgRow = `<tr><td colspan="7" style="text-align: center; font-weight: bold;">${mensaje}</td></tr>`;
      }
      tableBody.append(msgRow);
    }
  }
}
