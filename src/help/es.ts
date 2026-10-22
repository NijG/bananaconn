// Spanish version of the in-app usage guide (same sections, ids and icons as help.ts).

import type { HelpSection } from "../help";
import { icon } from "../icons";
import { esc } from "../ui";

const kbd = (k: string) => k.split("+").map((p) => `<kbd>${esc(p)}</kbd>`).join("+");

export const SECTIONS: HelpSection[] = [
  {
    id: "start",
    title: "Primeros pasos",
    icon: "Sparkles",
    body: `
      <p>BananaConn es una herramienta de acceso remoto que reúne en pestañas las conexiones SSH, Telnet, serie (COM), SFTP, FTP/FTPS, RDP y VNC.</p>
      <h4>Conectarse de inmediato (Conexión rápida)</h4>
      <ol>
        <li>Elija un protocolo (SSH, Telnet …) arriba a la izquierda.</li>
        <li>Escriba <code>user@host:port</code> en el cuadro contiguo y pulse ${kbd("Enter")}. Ejemplos: <code>root@10.0.0.5</code>, <code>admin@192.168.0.1:2222</code></li>
        <li>Para serie, escriba <code>COM3</code> o <code>COM3:115200</code>.</li>
      </ol>
      <h4>Guardarla como sesión</h4>
      <p>Guarde los datos de conexión con el botón ${icon("Plus", 13)} de la lista de sesiones (${kbd("Ctrl+Shift+N")}) y luego conéctese con doble clic o pulsando ${kbd("Enter")}. Las conexiones guardadas en otros programas se pueden traer de una sola vez con <a data-goto="import">Importar</a>.</p>
      <h4>Idioma de la interfaz</h4>
      <p><b>Idioma</b>, en la parte superior de Configuración, cambia la interfaz a 한국어, English, 日本語, 简体中文, 繁體中文, Tiếng Việt, Español, Français o Deutsch (al instante, sin desconectar; la guía y las notas de actualización también lo siguen). Hasta que elija uno, la aplicación sigue el idioma de visualización de Windows; una vez elegido, siempre prevalece su elección.</p>`,
  },
  {
    id: "sessions",
    title: "Lista de sesiones",
    icon: "Server",
    body: `
      <ul>
        <li><b>Carpetas</b>: en el editor de sesiones, escriba la carpeta con barras, como <code>Prod/Web servers</code>, para crear subcarpetas. También puede arrastrar una sesión sobre una carpeta para moverla.</li>
        <li><b>Orden</b>: el botón de ordenar sobre la lista de sesiones elige por nombre (AP2 antes que AP10), por dirección (IP comparadas como números), conectadas recientemente o personalizado. Arrastre una sesión encima o debajo de otra para colocarla ahí; las carpetas se reordenan, o se mueven a otra carpeta, del mismo modo. Reordenar cambia al orden personalizado, que se conserva. ${kbd("Alt+Up")} / ${kbd("Alt+Down")} mueven la sesión seleccionada un puesto, y «Ordenar esta carpeta por nombre/dirección» en el menú de una carpeta la ordena de una vez.</li>
        <li><b>Búsqueda</b>: escriba parte de un nombre, host, usuario o nota en el cuadro de búsqueda de la parte superior.</li>
        <li><b>Selección múltiple</b>: ${kbd("Ctrl")}+clic para elegir de una en una, ${kbd("Shift")}+clic para elegir un rango. ${kbd("Shift+↑/↓")} y ${kbd("Ctrl+A")} también funcionan. ${kbd("Esc")} borra la selección.</li>
        <li><b>Acciones masivas</b>: con varias seleccionadas, clic derecho → Edición masiva (${kbd("F2")}: usuario, puerto, credencial, carpeta, modo de teclas), Mover a carpeta, Eliminar (${kbd("Del")}), Conectar todas (${kbd("Enter")}).</li>
        <li><b>Copiar y pegar</b>: seleccione una sesión y pulse ${kbd("Ctrl+C")}, seleccione una sesión en la carpeta de destino y pulse ${kbd("Ctrl+V")}. Cada pegado crea una sesión nueva llamada "Nombre (2)", "Nombre (3)". Clic derecho → Duplicar hace lo mismo.</li>
        <li><b>Editar</b>: ${kbd("F2")} o clic derecho → Editar.</li>
      </ul>`,
  },
  {
    id: "import",
    title: "Importar desde otros programas",
    icon: "Download",
    body: `
      <p>Elija en el botón ${icon("Download", 13)} situado sobre la lista de sesiones. Antes de importar se muestra una lista de vista previa, y las sesiones existentes se omiten. <b>Las contraseñas no se importan</b> (cada programa las cifra con su propia clave). Introdúzcalas en la primera conexión o asigne una desde el almacén de credenciales.</p>
      <table class="help-table">
        <tr><th>Programa</th><th>Qué elegir</th></tr>
        <tr><td>MobaXterm</td><td><code>%APPDATA%\\MobaXterm\\MobaXterm.ini</code> (portable: junto al ejecutable)</td></tr>
        <tr><td>SecureCRT</td><td>Carpeta de sesiones <code>%APPDATA%\\VanDyke\\Config\\Sessions</code> (incluida la estructura de carpetas, los nombres de archivos de registro y la configuración de registro automático), o un XML creado con File → Export Settings</td></tr>
        <tr><td>mRemoteNG</td><td><code>%APPDATA%\\mRemoteNG\\confCons.xml</code> (si el cifrado del archivo completo está activado, desactívelo y guarde primero)</td></tr>
        <tr><td>PuTTY · KiTTY</td><td>Lee directamente la configuración de este PC</td></tr>
        <tr><td>WinSCP</td><td>La configuración de este PC o, si no hay, <code>WinSCP.ini</code></td></tr>
        <tr><td>Xshell</td><td>La carpeta <code>Documents\\NetSarang Computer\\&lt;version&gt;\\Xshell\\Sessions</code></td></tr>
        <tr><td>RDCMan</td><td>Archivo <code>.rdg</code></td></tr>
        <tr><td>Escritorio remoto</td><td>Una carpeta que contenga archivos <code>.rdp</code> (incluidas las subcarpetas)</td></tr>
        <tr><td>CSV</td><td>Nombres de columna en la primera línea: Name, Protocol, Host, Port, Username, Folder (separados por comas, punto y coma o tabulaciones)</td></tr>
      </table>
      <p>Entre instalaciones de BananaConn, use <b>Exportar/Importar copia de seguridad de sesiones (JSON)</b> en el mismo menú. La copia de seguridad incluye, además de las sesiones, las carpetas vacías, los fragmentos/macros y los túneles SSH. Si la restaura en el mismo PC, se conservan los vínculos con las credenciales, y aunque todas las sesiones ya existan puede restaurar solo las carpetas, los fragmentos y los túneles que falten. Los túneles SSH y las opciones relacionadas con la seguridad (ignorar errores de certificado, reenvío de puertos, ubicación del archivo de registro, etc.) solo se importan si activa "Importar también las opciones relacionadas con la seguridad".</p>`,
  },
  {
    id: "tabs",
    title: "Pestañas y vista dividida",
    icon: "LayoutGrid",
    body: `
      <ul>
        <li><b>Cerrar una pestaña</b>: ${kbd("Ctrl+F4")} o ${kbd("Ctrl+Shift+W")}, o clic central en la pestaña. Pulse ${kbd("Enter")} en la confirmación para cerrar; marque "No volver a preguntar" para omitirla la próxima vez (se puede volver a activar en Configuración).</li>
        <li><b>Volver a abrir la misma sesión</b>: haga <b>doble clic</b> en la pestaña. Útil para una segunda conexión al mismo dispositivo para supervisión.</li>
        <li><b>Cambiar de pestaña</b>: ${kbd("Ctrl+Tab")} / ${kbd("Ctrl+Shift+Tab")}. Con muchas pestañas, gire la rueda del ratón sobre la barra de pestañas para desplazarse a izquierda y derecha. Arrastre las pestañas para reordenarlas.</li>
        <li><b>Vista dividida</b>: los botones única / izquierda-derecha / arriba-abajo / 4 partes de la parte superior. Arrastre una pestaña al panel que desee.</li>
        <li>El color del punto de la pestaña indica el protocolo; si parpadea, se está conectando, y si es rojo, hay un error.</li>
      </ul>`,
  },
  {
    id: "terminal",
    title: "Terminal (SSH · Telnet · Serie)",
    icon: "SquareTerminal",
    body: `
      <ul>
        <li><b>Copiar y pegar</b>: al seleccionar arrastrando se copia de inmediato, y el clic derecho pega (configurable en Configuración). ${kbd("Ctrl+C")} solo copia cuando hay una selección; si no, se envía al dispositivo.</li>
        <li><b>Tamaño de fuente</b>: ${kbd("Ctrl")}+rueda del ratón, o ${icon("ZoomIn", 13)}${icon("ZoomOut", 13)} en la barra de herramientas.</li>
        <li><b>Buscar</b>: ${kbd("Ctrl+Shift+F")}.</li>
        <li><b>Modo de teclas</b>: si Delete, Home o End imprimen <code>~</code> en dispositivos como Cisco IOS, cambie la barra de herramientas a "Teclas: Dispositivo" (Delete=Ctrl-D, Home=Ctrl-A, End=Ctrl-E). Puede definir el valor predeterminado en el editor de sesiones.</li>
        <li><b>Serie</b>: en el editor de sesiones, defina el puerto COM ("Buscar puertos"), la velocidad, la paridad y el control de flujo. Break en la barra de herramientas envía una señal Break. Al pegar varias líneas o enviar una configuración con «Enviar un archivo de texto» en la barra de herramientas, las líneas se envían de una en una: cada línea sale en cuanto el dispositivo ha aceptado la anterior y vuelve a mostrar su prompt, así que los dispositivos rápidos la reciben enseguida y los lentos no pierden caracteres. Se muestra el progreso; ${kbd("Ctrl+C")}, Break o «Detener» en el cuadro de progreso descarta las líneas restantes. Para dispositivos sin eco, elija retardos fijos en Configuración → Terminal. Las sesiones Telnet a través de un servidor de consolas funcionan igual si activa «Conexión a servidor de consolas» en el editor de sesiones. Si se desconecta un adaptador serie USB, la pestaña espera al puerto y se reconecta en cuanto vuelve a conectarse. La E/S del puerto usa un modo rápido en el que las teclas nunca esperan a una lectura pendiente; si un controlador falla, cambie al modo de compatibilidad en Configuración → Terminal.</li>
        <li><b>Resaltado de palabras clave en la salida</b>: ERROR·FAIL en rojo, WARN en amarillo, OK·SUCCESS en verde.</li>
        <li><b>Renderizado</b> (Configuración → Terminal): "Automático" dibuja con la GPU (WebGL) en PC con tarjeta gráfica, lo que acelera las salidas intensas, y usa el renderizador estándar en servidores y sesiones remotas sin ella. Solo los terminales visibles en pantalla usan la GPU.</li>
        <li><b>Fragmentos y macros</b>: guarde los comandos que usa con frecuencia en Fragmentos de la barra de herramientas, y use "Grabar" para capturar la entrada y reproducirla.</li>
        <li><b>Archivos</b> (SSH): el botón Archivos de la barra de herramientas abre al lado un panel SFTP del mismo servidor.</li>
      </ul>`,
  },
  {
    id: "broadcast",
    title: "Difusión de entrada",
    icon: "Radio",
    body: `
      <p>Active <b>Difundir entrada</b> en la parte superior y las teclas escritas en el terminal actual irán a <b>todas las pestañas de terminal conectadas</b> (incluidas las que no están en pantalla). Las pestañas receptoras muestran un punto parpadeante. Úselo para enviar el mismo comando a varios dispositivos, y no olvide desactivarlo al terminar. Cada pestaña envía Delete, Home y End según su propio modo de teclas (estándar/dispositivo).</p>`,
  },
  {
    id: "log",
    title: "Registro de sesiones",
    icon: "ScrollText",
    body: `
      <p>Inicie y detenga el registro con el botón <b>Registro</b> de la barra de herramientas. Al iniciar puede comprobar y editar el nombre del archivo (se puede desactivar en Configuración), y al hacer clic en "Registrando" en la barra de estado se abre la carpeta que contiene el archivo.</p>
      <h4>Sustituciones en el nombre del archivo (igual que en SecureCRT)</h4>
      <table class="help-table">
        <tr><td><code>%S</code> nombre de sesión</td><td><code>%H</code> host</td><td><code>%U</code> usuario</td><td><code>%P</code> puerto</td></tr>
        <tr><td><code>%Y</code> año (4 dígitos)</td><td><code>%M</code> mes</td><td><code>%D</code> día</td><td><code>%%</code> signo %</td></tr>
        <tr><td><code>%h</code> hora</td><td><code>%m</code> minuto</td><td><code>%s</code> segundo</td><td><code>%t</code> milisegundo</td></tr>
      </table>
      <p>Ejemplo: <code>D:\\Checks\\CRT_Log\\%S (%H)_%Y%M%D.log</code> → <code>D:\\Checks\\CRT_Log\\SERVER01 (10.1.1.5)_20261015.log</code>. Las carpetas que falten se crean. Las rutas relativas quedan en Documents\\BananaConn\\logs.</p>
      <ul>
        <li><b>Si el archivo existe</b>: Anexar / Sobrescribir / Archivo nuevo (-2, -3 …).</li>
        <li><b>Prefijo en cada línea</b>: p. ej., <code>[%h:%m:%s] </code> para poner marca de tiempo a cada línea.</li>
        <li><b>Al iniciar / al detener</b>: texto que se escribe en el archivo (se permiten sustituciones).</li>
        <li><b>Archivo nuevo después de medianoche</b>: si el nombre contiene <code>%D</code>, el registro continúa en un archivo nuevo cuando cambia la fecha.</li>
        <li><b>Registrar automáticamente al conectar</b>: para todas las sesiones (Configuración → Registros) o por sesión (editor de sesiones → Registro → Solo esta sesión).</li>
      </ul>`,
  },
  {
    id: "macros",
    title: "Fragmentos · Macros",
    icon: "Circle",
    body: `
      <p>Guarde los comandos que usa con frecuencia (fragmentos), o grabe las teclas que escribe en un terminal y vuelva a enviarlas exactamente igual (macros).</p>
      <p><b>Fragmentos integrados por SO</b>: comprobaciones comunes de solo lectura (comandos que no cambian nada) para Linux, AIX, HP-UX, Solaris, Windows, Cisco IOS · NX-OS · ASA, FortiGate, Aruba, Juniper y Huawei. La lista de fragmentos muestra primero los suyos y los del SO reconocido en esa pestaña; los de otros sistemas están a un clic en "Fragmentos de …". Edítelos o elimínelos, o cambie su grupo de SO, en Administrar fragmentos.</p>
      <p><b>Comandos peligrosos</b>: cada línea que envía un fragmento o una macro se comprueba con las reglas de Configuración → Comandos peligrosos. Los comandos que cambian la hora o NTP (<code>timedatectl set-ntp</code>, <code>date -s</code>, <code>ntpdate</code>, <code>ntp server</code>, <code>clock set</code> …) se <b>bloquean</b> y nunca se envían; los comandos como reinicios, eliminaciones, formateos o cambios de configuración del dispositivo requieren confirmación previa en una <b>advertencia</b>. Al enviarlos se activa el registro de la pestaña, y cada intento, cancelación y bloqueo queda anotado en <code>risky-commands.log</code> en la carpeta de registros. También se comprueban los comandos encadenados con <code>;</code> o <code>&amp;&amp;</code>, los comandos dentro de <code>sudo</code>, <code>su -c</code>, <code>bash -c</code> o <code>eval</code>, y las líneas que continúan con una <code>\\</code> al final. Las macros con autocompletado con Tab o teclas de cursor (←→, Home, historial ↑↓) muestran una advertencia, porque no se puede saber qué comando se envía realmente. Los comandos que escribe usted mismo no se comprueban.</p>
      <h4>Crear y enviar fragmentos</h4>
      <ol>
        <li>En la barra de herramientas del terminal: <b>Fragmentos</b> → <b>Administrar fragmentos…</b> → <b>Nuevo fragmento</b>.</li>
        <li>Introduzca un nombre y el contenido que se enviará. Las líneas múltiples se envían de una en una con Enter (p. ej., <code>terminal length 0</code> seguido de <code>show running-config</code> en la línea siguiente).</li>
        <li>Con <b>Pulsar Enter después de enviar</b> activado, la última línea se ejecuta de inmediato; si está desactivado, el comando solo se escribe y queda a la espera.</li>
        <li>Para enviar uno, haga clic en <b>Fragmentos</b> en la barra de herramientas y elíjalo de la lista.</li>
      </ol>
      <h4>Grabar y reproducir macros</h4>
      <ol>
        <li>Haga clic en <b>Grabar</b> en la barra de herramientas del terminal; el botón cambia a <b>Detener grabación</b> y cada tecla que escriba desde ese momento se guarda tal cual (incluidas Enter, Tab, las teclas Ctrl, las flechas y la entrada del IME).</li>
        <li>Escriba los comandos en el dispositivo como de costumbre. Los fragmentos que envíe también se graban en la macro.</li>
        <li>Haga clic en <b>Detener grabación</b> y asígnele un nombre para guardarla.</li>
        <li>Para reproducirla, elija el elemento marcado como <b>Macro</b> en la lista <b>Fragmentos</b> de la barra de herramientas. Las teclas grabadas se envían en orden, exactamente como se escribieron.</li>
      </ol>
      <ul>
        <li><b>Muchos dispositivos a la vez</b>: envíe un fragmento o una macro con <b>Difundir entrada</b> activado en la parte superior y llegará a todas las pestañas de terminal conectadas.</li>
        <li><b>No grabe contraseñas</b>: las macros guardan las teclas exactamente como se escriben, así que una contraseña introducida durante la grabación también se guarda.</li>
        <li>Puede ver el contenido de las macros en <b>Administrar fragmentos…</b> (⏎ = Enter, ⇥ = Tab, ^C = Ctrl+C). Se pueden renombrar y eliminar, pero las teclas no se pueden editar; vuelva a grabarla para cambiarla.</li>
        <li>Los fragmentos y las macros se guardan en este PC y los comparten todas las sesiones.</li>
      </ul>`,
  },
  {
    id: "monitor",
    title: "Detección de dispositivos · CPU · Memoria",
    icon: "Activity",
    body: `
      <p>Cuando se conecta por SSH o Telnet, una conexión de supervisión independiente detecta automáticamente el tipo de dispositivo y muestra su nombre y la CPU/memoria (y el disco en servidores) en la barra de estado. No se escribe nada en el terminal.</p>
      <p>Dispositivos compatibles: <b>Cisco</b> IOS · IOS-XE · NX-OS · ASA, <b>Fortinet</b> FortiGate, <b>Aruba</b> AOS-CX · AOS-Switch (ProCurve) · controladoras inalámbricas, <b>Juniper</b> Junos, <b>Huawei</b> VRP, y servidores con <b>Linux (Red Hat, etc.)</b> · <b>AIX</b> · <b>HP-UX</b> · <b>Solaris</b>.</p>
      <ul>
        <li><b>Botón de dispositivo</b>: una vez detectado, aparece en la barra de herramientas del terminal un botón con el nombre del dispositivo. Haga clic en él para introducir de una vez los comandos show habituales de ese dispositivo (interfaces, enrutamiento, VLAN, HA, registros de errores, etc.). No incluye comandos que cambien la configuración.</li>
        <li><b>Respaldar configuración</b>: en dispositivos de red, botón de dispositivo → "Respaldar configuración" guarda la running-config (<code>show</code> en FortiGate) en un archivo <code>devicename_datetime.cfg</code>. La lee a través de la conexión de supervisión, así que no interfiere con el terminal en el que trabaja. No se guarda nada si el dispositivo lo rechaza por falta de permisos o si no llega el final de la configuración (<code>end</code> en IOS, <code>return</code> en Huawei, etc.).</li>
        <li><b>Modo de teclas automático</b>: cuando se detecta un dispositivo de red, las sesiones que aún no tienen un modo de teclas elegido cambian al modo de dispositivo (Delete=Ctrl-D, Home=Ctrl-A, End=Ctrl-E).</li>
        <li><b>Procesos principales</b>: haga clic en CPU/memoria en la barra de estado para ver los 10 procesos que más CPU y memoria usan y la lista de discos (Linux).</li>
        <li>La supervisión usa un inicio de sesión adicional. <b>Aunque haya varias pestañas abiertas al mismo dispositivo, solo se usa una conexión de supervisión</b> (para ahorrar líneas VTY del dispositivo).</li>
        <li>El sondeo se ejecuta cada 2 segundos en Linux (10 segundos por Telnet), 15 segundos en dispositivos de red y 10 segundos en AIX/HP-UX/Solaris. Los comandos de supervisión no quedan en el historial del shell del servidor (<code>~/.sh_history</code>, etc.). Se pausa cuando ninguna pestaña de ese dispositivo está en pantalla o la ventana está minimizada (los dispositivos se consultan solo una vez cada 5 minutos para que no se pierda el inicio de sesión), y lee de inmediato al volver a mostrarse.</li>
        <li>Si aparece "Haga clic para iniciar sesión", haga clic e introduzca la contraseña para la supervisión (no se guarda). Si no se conoce la contraseña, la conexión de supervisión se corta antes de enviar el nombre de usuario, así que no queda ningún inicio de sesión fallido en el dispositivo. Para un dispositivo Telnet al que se entra sin contraseña, deje la contraseña vacía e inicie. Si después de iniciar sesión el dispositivo pide algo más, como un código de un solo uso, no se realiza la supervisión. Para desactivarla: Configuración → Sesión.</li>
      </ul>`,
  },
  {
    id: "files",
    title: "Transferencia de archivos (SFTP · FTP · FTPS)",
    icon: "FolderOpen",
    body: `
      <ul>
        <li>El lado izquierdo es su PC y el derecho, el servidor. Arrastre elementos al otro lado o haga clic en el botón de transferencia. Las carpetas se envían con su contenido.</li>
        <li>Si existe un archivo con el mismo nombre, se le pregunta si desea sobrescribirlo. Las transferencias muestran el progreso y se pueden cancelar.</li>
        <li><b>TFTP</b>: elija TFTP como tipo de sesión (o en Conexión rápida) para abrir una pestaña TFTP. TFTP no tiene inicio de sesión ni listado de carpetas, así que escriba el <b>nombre del archivo en el servidor</b> y haga clic en "Obtener", o elija un archivo de su PC y haga clic en "Enviar". El tamaño de bloque "Automático" sirve para la mayoría de los dispositivos, y los servidores antiguos que no entienden opciones vuelven automáticamente a 512. Para que un dispositivo envíe archivos a su PC (p. ej., <code>copy running-config tftp:</code>), active el <b>Servidor TFTP</b> en el botón "Servidores" de la parte superior.</li>
        <li>Al enviar una carpeta por SFTP se transfieren 4 archivos a la vez, lo que es mucho más rápido para carpetas con muchos archivos pequeños, sobre todo a larga distancia. FTP envía de uno en uno por los límites de conexión del servidor, pero puede seguir explorando carpetas durante la transferencia.</li>
        <li>Haga doble clic en un archivo de texto del servidor para abrirlo en el editor integrado; al guardar se escribe directamente en el servidor.</li>
      </ul>`,
  },
  {
    id: "rdp",
    title: "Escritorio remoto (RDP) · VNC",
    icon: "Monitor",
    body: `
      <ul>
        <li><b>Tamaño de pantalla</b>: si la resolución de la sesión es "Automático", se ajusta al tamaño de la pestaña. Al cambiar el tamaño de la ventana también cambia la resolución remota, y si el servidor no admite el cambio en directo, se vuelve a conectar automáticamente con el nuevo tamaño.</li>
        <li><b>Ajustar</b>: elija si escalar la pantalla remota para ajustarla a la pestaña (activado) o verla a tamaño real (desactivado).</li>
        <li><b>Copiar y pegar</b>: como en mstsc, intercambie texto, imágenes y <b>archivos y carpetas</b> entre su PC y el PC remoto con ${kbd("Ctrl+C")} / ${kbd("Ctrl+V")} (opción de sesión "Compartir portapapeles"). Los archivos copiados en el lado remoto se descargan al pegar, con el progreso mostrado en la barra de herramientas.</li>
        <li>Teclado: el tipo y la distribución del teclado de su PC (p. ej., coreano de 103/106 teclas) se pasan tal cual al lado remoto, así que Shift/Ctrl/Alt derechos y las teclas Hangul/Hanja se comportan como en mstsc. El estado de Bloq Num y Bloq Mayús también se sincroniza en el servidor, así que el teclado numérico funciona en la pantalla de inicio de sesión sin volver a pulsar Bloq Num.</li>
        <li>Barra de herramientas: Enviar ${kbd("Ctrl+Alt+Del")}, tecla Windows, Escribir portapapeles (envía el texto del portapapeles como pulsaciones), Abrir en mstsc.</li>
        <li>En la primera conexión se verifica la huella digital del certificado del servidor; una vez que confíe, no se le volverá a preguntar.</li>
        <li>Mientras ve otra pestaña o la ventana está minimizada, esa pestaña RDP deja de dibujar y obtiene la pantalla completa de una vez cuando vuelve.</li>
        <li><b>Velocidad de VNC</b>: en "Calidad" de la barra de herramientas, elija Rápida (predeterminada: menos color/calidad, compresión máxima), Normal o Nítida (se aplica de inmediato sin desconectar). Active "Estado" para ver la codificación que usa el servidor y los datos recibidos por segundo. Si solo aparecen Raw o Hextile, el servidor no está usando compresión.</li>
        <li>Cuando VNC va lento, la causa suele estar en la <b>configuración del servidor</b>. Para TightVNC Server: en la configuración del servidor → pestaña Server, reduzca <b>Screen polling cycle</b> de 1000ms a 30–50ms, desactive <b>Grab transparent windows</b> y habilite el <b>controlador espejo (DFMirage)</b> si está instalado. Quitar el fondo de escritorio también ayuda mucho. En pantallas grandes como 4K, TightVNC puede quedarse decenas de segundos atrás (medido en un PC: TightVNC 34–46 s de retraso, UltraVNC casi en tiempo real). En ese caso use <b>UltraVNC Server</b>, con la duplicación de escritorio de Windows (DDengine) activada en su pestaña Capture.</li>
        <li>El RDP integrado no usa la aceleración gráfica de mstsc (H.264), así que puede ser más lento que mstsc cuando la pantalla cambia mucho. En ese caso use "Abrir en mstsc".</li>
      </ul>`,
  },
  {
    id: "tools",
    title: "Herramientas · Servidores de archivos",
    icon: "Waypoints",
    body: `
      <ul>
        <li><b>Puerta de enlace SSH</b>: en el editor de sesiones RDP, VNC o Telnet, elija una sesión SSH guardada como puerta de enlace para llegar a dispositivos detrás de un firewall a través de ese servidor.</li>
        <li><b>Proxy</b>: en «Proxy» del editor de sesiones elija, como en Connection → Proxy de PuTTY, SOCKS 4/4a, SOCKS 5, HTTP CONNECT, Telnet (conectar con un comando) o un comando local. SSH, SFTP, Telnet, FTP/FTPS, RDP y VNC, y el monitor de recursos de la sesión, pasan por él. Elija el inicio de sesión del proxy en el almacén de credenciales e indique los hosts que no usan el proxy (*.corp.local, 10.0.0.0/8), dónde se resuelven los nombres y si se muestra el diagnóstico. FTP usa el modo pasivo a través de un proxy. Las sesiones importadas de PuTTY o KiTTY conservan su proxy (sin la contraseña).</li>
        <li><b>Túneles SSH</b>: Herramientas en la parte superior → Túneles SSH. Guarde reenvíos de puerto local → servidor SSH → dirección de destino y actívelos o desactívelos.</li>
        <li><b>Herramientas de red</b>: ping, comprobación de puertos TCP (varios puertos y rangos), consulta DNS.</li>
        <li><b>Servidores de archivos</b>: el botón de servidor de archivos de la parte superior comparte temporalmente una carpeta de este PC por FTP, TFTP o HTTP (p. ej., para cargar imágenes del SO de dispositivos).</li>
      </ul>`,
  },
  {
    id: "security",
    title: "Credenciales · Seguridad",
    icon: "KeyRound",
    body: `
      <ul>
        <li><b>Almacén de credenciales</b> (botón de llave en la parte superior): guarda contraseñas y claves SSH en el Administrador de credenciales de Windows para usarlas en el editor de sesiones. Las contraseñas guardadas nunca se muestran en pantalla.</li>
        <li><b>Contraseña maestra</b> (Configuración → Seguridad): bloquea la aplicación al iniciarse y tras un periodo de ausencia.</li>
        <li>Las claves de host SSH/SFTP se comprueban con <code>~/.ssh/known_hosts</code>; las claves desconocidas muestran una huella digital para confirmarla. Las claves que cambian bloquean la conexión.</li>
      </ul>`,
  },
  {
    id: "update",
    title: "Actualizaciones",
    icon: "RefreshCw",
    body: `
      <p>Al iniciar y <b>cada 30 minutos</b> mientras está abierta (y al volver a la ventana tras un rato), la app busca una versión nueva en <b>GitHub</b> (github.com/NijG/bananaconn). En un equipo cuya política de seguridad bloquea GitHub, indique una <b>carpeta de actualizaciones en el NAS</b> (una carpeta compartida donde se publican las versiones nuevas) en Configuración → Actualización; se consulta cuando no se puede acceder a GitHub. Cuando encuentra una versión nueva, <b>una ventana pregunta si desea actualizar ahora</b>. "Actualizar ahora" cierra la app, instala y la vuelve a abrir (las conexiones abiertas se cierran). Con "Más tarde", el botón <b>Actualizar</b> a la derecha de la barra de estado la instala en cualquier momento. La ventana se abre con "Más tarde" seleccionado, así que un Enter escrito para un terminal nunca inicia una actualización.</p>
      <p><b>Cuando falla con "la contraseña es incorrecta"</b>: Windows se conecta a una carpeta compartida con la cuenta de Windows con la que ha iniciado sesión y no recurre al acceso de invitado aunque el recurso compartido permita la lectura anónima (invitado). Abra la carpeta de actualizaciones en el Explorador, introduzca la cuenta del NAS y marque "Recordar mis credenciales", o elija una cuenta del almacén de credenciales en <b>Cuenta del NAS</b> en Configuración → Actualizaciones. La aplicación iniciará sesión con ella.</p>
      <p>Solo se instalan los archivos firmados por el PC de compilación, así que no se instalan los archivos que otras personas coloquen en la carpeta compartida. También puede comprobarlo de inmediato con "Comprobar ahora".</p>`,
  },
  {
    id: "keys",
    title: "Atajos de teclado",
    icon: "Keyboard",
    body: `
      <p>Todos los atajos se pueden ver y cambiar en <b>Configuración → Atajos de teclado</b> (o «Configuración de atajos de teclado» en la pantalla de inicio). Las acciones sin atajo (diseños, n.ª pestaña, registro…) y los fragmentos o macros también pueden recibir uno, y «Predeterminado» en cada acción o «Restablecer todo a los valores predeterminados» deshace los cambios. La tabla muestra los valores predeterminados.</p>
      <table class="help-table">
        <tr><td>${kbd("F1")}</td><td>Esta ayuda (dentro de un terminal se envía al programa remoto)</td></tr>
        <tr><td>${kbd("Ctrl+Shift+N")}</td><td>Nueva sesión</td></tr>
        <tr><td>${kbd("Ctrl+Shift+K")}</td><td>Ir a Conexión rápida</td></tr>
        <tr><td>${kbd("Ctrl+Tab")} / ${kbd("Ctrl+Shift+Tab")}</td><td>Pestaña siguiente / anterior</td></tr>
        <tr><td>${kbd("Ctrl+F4")} · ${kbd("Ctrl+Shift+W")}</td><td>Cerrar pestaña</td></tr>
        <tr><td>Doble clic en la pestaña</td><td>Volver a abrir la misma sesión</td></tr>
        <tr><td>${kbd("Ctrl+Shift+F")}</td><td>Buscar en el terminal</td></tr>
        <tr><td>${kbd("Ctrl")}+rueda</td><td>Tamaño de fuente del terminal</td></tr>
        <tr><td>${kbd("Ctrl+Shift+B")}</td><td>Contraer barra lateral</td></tr>
        <tr><td colspan="2"><b>En la lista de sesiones</b></td></tr>
        <tr><td>${kbd("Enter")} / ${kbd("F2")} / ${kbd("Del")}</td><td>Conectar / Editar / Eliminar (se aplica a todas cuando hay varias seleccionadas)</td></tr>
        <tr><td>${kbd("Ctrl+C")} / ${kbd("Ctrl+V")}</td><td>Copiar / pegar sesiones</td></tr>
        <tr><td>${kbd("Ctrl")}·${kbd("Shift")}+clic, ${kbd("Ctrl+A")}</td><td>Selección múltiple</td></tr>
      </table>`,
  },
];
