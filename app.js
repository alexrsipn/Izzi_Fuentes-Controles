(function ($) {
  window.OfscPlugin = function (debugMode) {
    this.debugMode = debugMode || false;
    this.credentials = {};

    //NO DEBE IRSE A APROVISIONAMIENTO
    this.validationManager = new ValidationManager(); // Instancia de la clase ValidationManager

    this.aid = null; //variable para obtener la lista de inventarios
    this.userType = null; //variable para obtener el tipo de usuario
  };

  $.extend(window.OfscPlugin.prototype, {
    // Método para verificar si una cadena es JSON
    _isJson: function (str) {
      try {
        JSON.parse(str);
      } catch (e) {
        return false;
      }
      return true;
    },

    // Obtener el origen del mensaje
    _getOrigin: function (url) {
      if (url !== "") {
        if (url.indexOf("://") > -1) {
          return "https://" + url.split("/")[2];
        } else {
          return "https://" + url.split("/")[0];
        }
      }
      return "";
    },

    // Enviar datos al postMessage de OFSC
    _sendPostMessageData: function (data) {
      var originUrl =
        document.referrer ||
        (document.location.ancestorOrigins &&
          document.location.ancestorOrigins[0]) ||
        "";
      var targetOrigin = this._getOrigin(originUrl);
      parent.postMessage(data, targetOrigin);
    },
    // Método que se invoca cuando el plugin se inicializa
    pluginInitEnd: function (data) {
      var messageData = {
        apiVersion: 1,
        method: "initEnd",
      };
      this._sendPostMessageData(messageData);
    },
    // Método que se invoca cuando el plugin es abierto
    pluginOpen: async function (receivedData) {
      // console.log('Datos recibidos en pluginOpen:', receivedData);
      this.aid = receivedData.activity.aid; //***NO SE NECESITA EN APROVISIONAMIENTO

      //CONTROLA LA VISIBILIDAD DE LAS PESTAÑAS SEGÚN EL TIPO DE USUARIO
      let fullUrl = receivedData.securedData.urlOFSC;
      // Extraer la base de la URL hasta ".com/"
      let urlBaseMatch = fullUrl.match(/^https?:\/\/[^\/]+\.com\//);
      let urlBase = urlBaseMatch ? urlBaseMatch[0] : fullUrl;
      const credentialsValidador = {
        ofscRestClientId: receivedData.securedData.ofscRestClientId,
        ofscRestSecretId: receivedData.securedData.ofscRestSecretId,
        urlOFSC: urlBase,
      };
      this.validationManager.setCredentials(credentialsValidador);
      const userLogin = receivedData.user ? receivedData.user.ulogin : null; //***NO SE DEBE IR AL APROVISINAMIENTO */
      if (userLogin) {
        this.userType = await this.obtenerTipoUsuario(
          userLogin,
          credentialsValidador
        );
        // console.log('Tipo de usuario:', this.userType);
        this.controlarVisibilidadTabs(this.userType);
        $("#consulta").hide();
      } //***NO SE DEBE IR AL APROVISINAMIENTO */
      //FIN DE CONTROL DE VISIBILIDAD DE PESTAÑAS SEGÚN EL TIPO DE USUARIO

      let self = this; // Guardar referencia al contexto de OfscPlugin

      // Botón "Cargar Configuración"
      $("#loadConfigBtn").on("click", async function () {
        $("#statusMessage").text("Cargando configuración...");
        await self.validationManager.loadRulesConfig(); // Llama al método del plugin
        self.validationManager.generateSapIdList(); // Genera la lista de sapIdList

        // Actualizar la tabla de configuración
        const rulesConfig = self.validationManager.rulesConfig;
        const tableBody = $("#configTable tbody");
        tableBody.empty(); // Limpiar filas existentes

        rulesConfig.forEach((rule) => {
          const fuentesStr = Array.isArray(rule.fuentes)
            ? rule.fuentes.join(", ")
            : rule.fuentes || "";
          const controlesStr = Array.isArray(rule.controles)
            ? rule.controles.join(", ")
            : rule.controles || "";
          const row = `
            <tr>
                <td>${rule.skuequipo}</td>
                <td>${rule.descripcion}</td>
                <td>${fuentesStr}</td>
                <td>${controlesStr}</td>
            </tr>`;
          tableBody.append(row);
        });

        $("#statusMessage").text("Configuración consultada exitosamente.");
      });

      //3 LINEAS QUE DEBEN COPIARSE EN APROVISIONAMIENTO PARA MANEJO DE REGLAS EQUIPOS FUENTES CONTROLES
      this.controlefc = new ContoladorReglasEFC(this); //INCORPORACIÓN MAS LIMPIA DE REGLAS EFC ***SI SE NECESITA EN APROVISIONAMIENTO
      let resvalefc = await this.controlefc.ejecutarValidacionEFC(receivedData); //INCORPORACIÓN MAS LIMPIA DE REGLAS EFC ***SI SE NECESITA EN APROVISIONAMIENTO
      if (!resvalefc) {
        return -1;
      } //INCORPORACIÓN MAS LIMPIA DE REGLAS EFC ***SI SE NECESITA EN APROVISIONAMIENTO
      //FIN DE 3 LINEAS QUE DEBEN COPIARSE EN APROVISIONAMIENTO PARA MANEJO DE REGLAS EQUIPOS FUENTES CONTROLES
    },
    //***INICIAN MÉTODOS QUE APLICAN EN APROVISIONAMIENTO (VER DETALLES INTERNOS EN EL QUE ALGUNAS LINEAS DEBEN SER EXCLUIDAS EN EL APROV) */

    //,
    // Método para vincular el botón de validación
    bindValidationButton: function () {
      //***NO SE USARÁ EN PLUGIN DE APROVIIONAMIENTO */
      $("#validateBtn")
        .off("click")
        .on("click", () => {
          $("#statusMessage").text("Validando inventario...");

          const { valid, errors } = this.validateAndFilterInventory(
            this.installedInventories,
            this.customerInventories
          );

          // Limpiar y mostrar mensajes
          $("#statusMessage").empty();
          //   this.displayValidationResults(valid, errors);           //***NO SE USARÁ EN PLUGIN DE APROVIIONAMIENTO */
          //    this.updateInventoryResults(valid, errors);
        });
    },
    // Escuchar mensajes desde OFSC
    _getPostMessageData: function (event) {
      if (typeof event.data === "undefined") {
        console.error("No se recibieron datos en el evento.");
        return false;
      }

      if (!this._isJson(event.data)) {
        console.error("El dato recibido no es un JSON válido.");
        return false;
      }

      var data = JSON.parse(event.data);

      switch (data.method) {
        case "init":
          this.pluginInitEnd(data);
          break;
        case "open":
          this.pluginOpen(data);
          break;
        default:
          console.warn("Método desconocido: ", data.method);
      }
    },
    // Método para obtener el tipo de usuario   ***no se usará en aprovisionamiento
    obtenerTipoUsuario: async function (ulogin, credentialsValidador) {
      if (!credentialsValidador) {
        throw new Error("Credenciales no establecidas");
      }

      // Concatenar credenciales en formato adecuado
      //  let urlBaseMatch = credentialsValidador.urlOFSC.match(/^https?:\/\/[^\/]+\.com\//);
      var urlInstance = credentialsValidador.urlOFSC
        .replace("https://", "")
        .split(".fs.ocs.oraclecloud.com")[0];
      var credentialsStr =
        credentialsValidador.ofscRestClientId +
        ":" +
        credentialsValidador.ofscRestSecretId;

      const { urlOFSC } = credentialsValidador;

      // Codificar en base64
      var encodedCredentials = window.btoa(credentialsStr);

      try {
        const response = await fetch(
          `${urlOFSC}/rest/ofscCore/v1/users/${ulogin}`,
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
            `Error al obtener el usuario: ${response.statusText}`
          );
        }

        // ✅ Usar await aquí para obtener los datos una sola vez
        const userData = await response.json();
        // console.log('Datos del usuario:', userData);

        return userData.userType && userData.userType.trim() !== ""
          ? userData.userType
          : "No disponible";
      } catch (error) {
        console.error("Error al obtener el tipo de usuario:", error);
        return "Error";
      }
    },
    // Método para controlar la visibilidad de las pestañas ***no se usará en aprovisionamiento
    controlarVisibilidadTabs: function (tipoUsuario) {
      const tabPermisos = {
        TECNICO: ["validacion"],
        "TECNICO CONTROLES": ["validacion"],
        zTecnico_emer: ["validacion"],
        CTR_OPER: ["validacion", "consulta"],
        "zControl Opera2": ["validacion", "consulta"],
        MONITOR: ["validacion", "consulta"],
        ADM: ["consulta", "administracion"],
        UT1_DISPLAY_PROFILE: ["consulta", "administracion"],
      };

      $(".tab").each(function () {
        const tabId = $(this).data("tab");
        if (
          tabPermisos[tipoUsuario] &&
          tabPermisos[tipoUsuario].includes(tabId)
        ) {
          $(this).show();
          $("#" + tabId).show();
        } else {
          $(this).hide();
          $("#" + tabId).hide();
        }
      });

      // Mostrar los tabs solo después de aplicar la visibilidad correcta
      // setTimeout(() => {
      $(".tabs").css("opacity", "1"); // 🔹 Muestra los tabs después del retraso
      //}, 1000); // 🔹 Espera 1 segundo antes de mostrar los tabs
    },
    handleFileUpload: function () {
      const fileInput = document.getElementById("configFile");
      const file = fileInput.files[0];
      const self = this;

      if (!file) {
        $("#uploadStatusMessage")
          .text("❌ No se seleccionó ningún archivo.")
          .css("color", "red");
        return;
      }

      const reader = new FileReader();
      reader.onload = (event) => {
        try {
          const data = new Uint8Array(event.target.result);
          const workbook = XLSX.read(data, { type: "array" });
          const sheet = workbook.Sheets[workbook.SheetNames[0]];
          const jsonData = XLSX.utils.sheet_to_json(sheet, { defval: "" });

          const transformedData = jsonData
            .map((row) => {
              const fuentes = (row.skuequipo || "")
                .toString()
                .split(",")
                .map((f) => f.trim())
                .filter(Boolean);
              const controles = (row.skucontrol || "")
                .toString()
                .split(",")
                .map((c) => c.trim())
                .filter(Boolean);

              return {
                skuequipo: (row.skuequipo || "").toString().trim(),
                descripcion: (row.descripcion || "").toString().trim(),
                fuentes: fuentes.length > 0 ? fuentes : ["NA"],
                controles: controles.length > 0 ? controles : ["NA"],
              };
            })
            .filter((rule) => rule.skuequipo); // Filtrar reglas sin skuequipo

          self.validationManager.rulesConfig = transformedData;
          self.validationManager.generateSapIdList(); // Regenerar la lista de sapIdList

          console.log(
            "Datos cargados desde el archivo:",
            self.validationManager.rulesConfig
          );
          $("#uploadStatusMessage")
            .text("✅ Archivo cargado y procesado correctamente.")
            .css("color", "green");
          $("#loadConfigBtn").click(); // Simular clic para cargar la configuración y actualizar la tabla
        } catch (error) {
          console.error("Error al leer el archivo:", error);
          $("#uploadStatusMessage")
            .text("❌ Error al leer el archivo.")
            .css("color", "red");
        }
      };

      reader.readAsArrayBuffer(file);
    },
    // Inicialización del plugin
    init: function () {
      window.addEventListener(
        "message",
        this._getPostMessageData.bind(this),
        false
      );
      var initMessage = {
        apiVersion: 1,
        method: "ready",
        sendInitData: true,
      };
      this._sendPostMessageData(initMessage);
      console.log("Plugin inicializado.");
    },
  });

  // Inicializar el plugin al cargar la página
  $(document).ready(function () {
    var plugin = new OfscPlugin(true);
    plugin.init();

    // Vincular el botón de carga de configuración
    $("#uploadConfigBtn").on(
      "click",
      function () {
        plugin.handleFileUpload();
      }.bind(plugin)
    );

    //   this.controlarVisibilidadTabs("TECNICO");
  });
})(jQuery);
