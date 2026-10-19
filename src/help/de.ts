// German version of the in-app usage guide (same sections, ids and icons as help.ts).

import type { HelpSection } from "../help";
import { icon } from "../icons";
import { esc } from "../ui";

const kbd = (k: string) => k.split("+").map((p) => `<kbd>${esc(p)}</kbd>`).join("+");

export const SECTIONS: HelpSection[] = [
  {
    id: "start",
    title: "Erste Schritte",
    icon: "Sparkles",
    body: `
      <p>BananaConn ist ein Fernzugriffswerkzeug, das SSH-, Telnet-, serielle (COM), SFTP-, FTP/FTPS-, RDP- und VNC-Verbindungen in Tabs zusammenführt.</p>
      <h4>Sofort verbinden (Schnellverbindung)</h4>
      <ol>
        <li>Wählen Sie oben links ein Protokoll (SSH, Telnet …).</li>
        <li>Geben Sie <code>user@host:port</code> in das Feld daneben ein und drücken Sie ${kbd("Enter")}. Beispiele: <code>root@10.0.0.5</code>, <code>admin@192.168.0.1:2222</code></li>
        <li>Für seriell geben Sie <code>COM3</code> oder <code>COM3:115200</code> ein.</li>
      </ol>
      <h4>Als Sitzung speichern</h4>
      <p>Speichern Sie Verbindungsdaten mit der Schaltfläche ${icon("Plus", 13)} in der Sitzungsliste (${kbd("Ctrl+Shift+N")}) und verbinden Sie sich dann per Doppelklick oder mit ${kbd("Enter")}. In anderen Programmen gespeicherte Verbindungen lassen sich mit <a data-goto="import">Importieren</a> in einem Schritt übernehmen.</p>
      <h4>Anzeigesprache</h4>
      <p><b>Sprache</b> oben in den Einstellungen schaltet die Oberfläche auf 한국어, English, 日本語, 简体中文, 繁體中文, Tiếng Việt, Español, Français oder Deutsch um (sofort, ohne Verbindungen zu trennen; auch die Anleitung und die Update-Hinweise folgen). Bis Sie eine Sprache wählen, folgt die App der Windows-Anzeigesprache; danach gilt immer Ihre Wahl.</p>`,
  },
  {
    id: "sessions",
    title: "Sitzungsliste",
    icon: "Server",
    body: `
      <ul>
        <li><b>Ordner</b>: Schreiben Sie im Sitzungseditor den Ordner mit Schrägstrichen, etwa <code>Prod/Web servers</code>, um Unterordner anzulegen. Sie können eine Sitzung auch auf einen Ordner ziehen, um sie zu verschieben.</li>
        <li><b>Suche</b>: Geben Sie einen Teil eines Namens, Hosts, Benutzers oder einer Notiz in das Suchfeld oben ein.</li>
        <li><b>Mehrfachauswahl</b>: ${kbd("Ctrl")}+Klick wählt einzeln aus, ${kbd("Shift")}+Klick einen Bereich. ${kbd("Shift+↑/↓")} und ${kbd("Ctrl+A")} funktionieren ebenfalls. ${kbd("Esc")} hebt die Auswahl auf.</li>
        <li><b>Sammelaktionen</b>: Bei mehreren ausgewählten Sitzungen Rechtsklick → Gemeinsam bearbeiten (${kbd("F2")}: Benutzer, Port, Anmeldedaten, Ordner, Tastaturmodus), In Ordner verschieben, Löschen (${kbd("Del")}), Alle verbinden (${kbd("Enter")}).</li>
        <li><b>Kopieren &amp; Einfügen</b>: Wählen Sie eine Sitzung und drücken Sie ${kbd("Ctrl+C")}, wählen Sie eine Sitzung im Zielordner und drücken Sie ${kbd("Ctrl+V")}. Jedes Einfügen erstellt eine neue Sitzung namens „Name (2)“, „Name (3)“. Rechtsklick → Duplizieren bewirkt dasselbe.</li>
        <li><b>Bearbeiten</b>: ${kbd("F2")} oder Rechtsklick → Bearbeiten.</li>
      </ul>`,
  },
  {
    id: "import",
    title: "Aus anderen Programmen importieren",
    icon: "Download",
    body: `
      <p>Wählen Sie über die Schaltfläche ${icon("Download", 13)} oberhalb der Sitzungsliste. Vor dem Import wird eine Vorschauliste angezeigt, vorhandene Sitzungen werden übersprungen. <b>Passwörter werden nicht importiert</b> (jedes Programm verschlüsselt sie mit einem eigenen Schlüssel). Geben Sie sie bei der ersten Verbindung ein oder weisen Sie sie aus dem Anmeldedaten-Tresor zu.</p>
      <table class="help-table">
        <tr><th>Programm</th><th>Was auswählen</th></tr>
        <tr><td>MobaXterm</td><td><code>%APPDATA%\\MobaXterm\\MobaXterm.ini</code> (portabel: neben der ausführbaren Datei)</td></tr>
        <tr><td>SecureCRT</td><td>Sitzungsordner <code>%APPDATA%\\VanDyke\\Config\\Sessions</code> (inklusive Ordnerstruktur, Protokolldateinamen und Einstellungen zur automatischen Protokollierung) oder eine mit File → Export Settings erstellte XML</td></tr>
        <tr><td>mRemoteNG</td><td><code>%APPDATA%\\mRemoteNG\\confCons.xml</code> (wenn die Verschlüsselung der ganzen Datei aktiv ist, schalten Sie sie zuerst aus und speichern)</td></tr>
        <tr><td>PuTTY · KiTTY</td><td>Liest die Einstellungen dieses PCs direkt</td></tr>
        <tr><td>WinSCP</td><td>Die Einstellungen dieses PCs oder, falls keine vorhanden, <code>WinSCP.ini</code></td></tr>
        <tr><td>Xshell</td><td>Der Ordner <code>Documents\\NetSarang Computer\\&lt;version&gt;\\Xshell\\Sessions</code></td></tr>
        <tr><td>RDCMan</td><td><code>.rdg</code>-Datei</td></tr>
        <tr><td>Remotedesktop</td><td>Ein Ordner mit <code>.rdp</code>-Dateien (inklusive Unterordnern)</td></tr>
        <tr><td>CSV</td><td>Spaltennamen in der ersten Zeile: Name, Protocol, Host, Port, Username, Folder (durch Komma, Semikolon oder Tab getrennt)</td></tr>
      </table>
      <p>Zwischen BananaConn-Installationen verwenden Sie <b>Sitzungssicherung exportieren/importieren (JSON)</b> im selben Menü. Die Sicherung enthält neben den Sitzungen auch leere Ordner, Snippets/Makros und SSH-Tunnel. Bei der Wiederherstellung auf demselben PC bleiben die Verknüpfungen zu den Anmeldedaten erhalten, und auch wenn alle Sitzungen schon vorhanden sind, lassen sich nur die fehlenden Ordner, Snippets und Tunnel wiederherstellen. SSH-Tunnel und sicherheitsrelevante Optionen (Zertifikatsfehler ignorieren, Portweiterleitung, Speicherort der Protokolldatei usw.) werden nur importiert, wenn „Auch sicherheitsrelevante Optionen importieren“ aktiviert ist.</p>`,
  },
  {
    id: "tabs",
    title: "Tabs und geteilte Ansicht",
    icon: "LayoutGrid",
    body: `
      <ul>
        <li><b>Tab schließen</b>: ${kbd("Ctrl+F4")} oder ${kbd("Ctrl+Shift+W")} oder Mittelklick auf den Tab. Drücken Sie in der Bestätigung ${kbd("Enter")} zum Schließen; mit „Nicht mehr fragen“ entfällt sie künftig (in den Einstellungen wieder aktivierbar).</li>
        <li><b>Dieselbe Sitzung erneut öffnen</b>: <b>Doppelklick</b> auf den Tab. Praktisch für eine zweite Verbindung zum selben Gerät zur Überwachung.</li>
        <li><b>Tabs wechseln</b>: ${kbd("Ctrl+Tab")} / ${kbd("Ctrl+Shift+Tab")}. Bei vielen Tabs scrollen Sie mit dem Mausrad über der Tab-Leiste nach links und rechts. Ziehen Sie Tabs, um sie neu anzuordnen.</li>
        <li><b>Geteilte Ansicht</b>: Die Schaltflächen Einzeln / Nebeneinander / Übereinander / 4-fach oben. Ziehen Sie einen Tab in den gewünschten Bereich.</li>
        <li>Die Farbe des Tab-Punkts zeigt das Protokoll, Blinken bedeutet Verbindungsaufbau und Rot einen Fehler.</li>
      </ul>`,
  },
  {
    id: "terminal",
    title: "Terminal (SSH · Telnet · Seriell)",
    icon: "SquareTerminal",
    body: `
      <ul>
        <li><b>Kopieren &amp; Einfügen</b>: Markieren durch Ziehen kopiert sofort, Rechtsklick fügt ein (in den Einstellungen konfigurierbar). ${kbd("Ctrl+C")} kopiert nur, wenn etwas markiert ist; sonst wird es an das Gerät gesendet.</li>
        <li><b>Schriftgröße</b>: ${kbd("Ctrl")}+Mausrad oder ${icon("ZoomIn", 13)}${icon("ZoomOut", 13)} in der Symbolleiste.</li>
        <li><b>Suchen</b>: ${kbd("Ctrl+Shift+F")}.</li>
        <li><b>Tastaturmodus</b>: Wenn Delete, Home oder End auf Geräten wie Cisco IOS <code>~</code> ausgeben, schalten Sie die Symbolleiste auf „Tasten: Gerät“ um (Delete=Ctrl-D, Home=Ctrl-A, End=Ctrl-E). Den Standard legen Sie im Sitzungseditor fest.</li>
        <li><b>Seriell</b>: Legen Sie im Sitzungseditor COM-Port („Ports suchen“), Geschwindigkeit, Parität und Flusssteuerung fest. Break in der Symbolleiste sendet ein Break-Signal. Mehrzeilig Eingefügtes wird Zeile für Zeile mit kurzer Pause gesendet, damit das Gerät keine Zeichen verliert; mit ${kbd("Ctrl+C")} oder Break werden die restlichen Zeilen nicht mehr gesendet.</li>
        <li><b>Hervorhebung von Schlüsselwörtern</b>: ERROR·FAIL rot, WARN gelb, OK·SUCCESS grün.</li>
        <li><b>Darstellung</b> (Einstellungen → Terminal): „Automatisch“ zeichnet auf PCs mit Grafikkarte per GPU (WebGL), was umfangreiche Ausgaben beschleunigt, und nutzt auf Servern und Remote-Sitzungen ohne Grafikkarte den Standard-Renderer. Nur auf dem Bildschirm sichtbare Terminals verwenden die GPU.</li>
        <li><b>Snippets &amp; Makros</b>: Speichern Sie häufig verwendete Befehle unter Snippets in der Symbolleiste und zeichnen Sie mit „Aufnahme“ Eingaben auf, um sie wieder abzuspielen.</li>
        <li><b>Dateien</b> (SSH): Die Schaltfläche „Dateien“ in der Symbolleiste öffnet daneben einen SFTP-Bereich für denselben Server.</li>
      </ul>`,
  },
  {
    id: "broadcast",
    title: "Eingabe an alle senden",
    icon: "Radio",
    body: `
      <p>Schalten Sie oben <b>Eingabe an alle</b> ein, dann gehen die im aktuellen Terminal getippten Tasten an <b>jeden verbundenen Terminal-Tab</b> (auch an nicht sichtbare Tabs). Empfangende Tabs haben einen blinkenden Punkt. Verwenden Sie dies, um denselben Befehl an mehrere Geräte zu senden, und schalten Sie es danach unbedingt wieder aus. Jeder Tab sendet Delete, Home und End gemäß seinem eigenen Tastaturmodus (Standard/Gerät).</p>`,
  },
  {
    id: "log",
    title: "Sitzungsprotokollierung",
    icon: "ScrollText",
    body: `
      <p>Starten und stoppen Sie mit der Schaltfläche <b>Protokoll</b> in der Symbolleiste. Beim Start können Sie den Dateinamen prüfen und ändern (in den Einstellungen abschaltbar), und ein Klick auf „Protokollierung“ in der Statusleiste öffnet den Ordner mit der Datei.</p>
      <h4>Platzhalter im Dateinamen (wie in SecureCRT)</h4>
      <table class="help-table">
        <tr><td><code>%S</code> Sitzungsname</td><td><code>%H</code> Host</td><td><code>%U</code> Benutzer</td><td><code>%P</code> Port</td></tr>
        <tr><td><code>%Y</code> Jahr (4-stellig)</td><td><code>%M</code> Monat</td><td><code>%D</code> Tag</td><td><code>%%</code> %-Zeichen</td></tr>
        <tr><td><code>%h</code> Stunde</td><td><code>%m</code> Minute</td><td><code>%s</code> Sekunde</td><td><code>%t</code> Millisekunde</td></tr>
      </table>
      <p>Beispiel: <code>D:\\Checks\\CRT_Log\\%S (%H)_%Y%M%D.log</code> → <code>D:\\Checks\\CRT_Log\\SERVER01 (10.1.1.5)_20261015.log</code>. Fehlende Ordner werden angelegt. Relative Pfade liegen unter Dokumente\\BananaConn\\logs.</p>
      <ul>
        <li><b>Wenn die Datei existiert</b>: Anhängen / Überschreiben / Neue Datei (-2, -3 …).</li>
        <li><b>Präfix für jede Zeile</b>: z. B. <code>[%h:%m:%s] </code>, um jede Zeile mit einem Zeitstempel zu versehen.</li>
        <li><b>Bei Start / bei Ende</b>: Text, der in die Datei geschrieben wird (Platzhalter erlaubt).</li>
        <li><b>Neue Datei nach Mitternacht</b>: Enthält der Name <code>%D</code>, wird bei Datumswechsel in einer neuen Datei weiterprotokolliert.</li>
        <li><b>Beim Verbinden automatisch protokollieren</b>: Für alle Sitzungen (Einstellungen → Protokolle) oder pro Sitzung (Sitzungseditor → Protokoll → Nur diese Sitzung).</li>
      </ul>`,
  },
  {
    id: "macros",
    title: "Snippets · Makros",
    icon: "Circle",
    body: `
      <p>Speichern Sie häufig verwendete Befehle (Snippets) oder zeichnen Sie die in einem Terminal getippten Tasten auf und senden Sie sie exakt erneut (Makros).</p>
      <p><b>Integrierte Snippets je Betriebssystem</b>: gängige schreibgeschützte Prüfungen (Befehle, die nichts ändern) für Linux, AIX, HP-UX, Solaris, Windows, Cisco IOS · NX-OS · ASA, FortiGate, Aruba, Juniper und Huawei. Die Snippet-Liste zeigt zuerst Ihre eigenen Snippets und die für das in diesem Tab erkannte Betriebssystem; andere Systeme sind mit einem Klick unter „…-Snippets“ erreichbar. Unter „Snippets verwalten“ können Sie sie bearbeiten, löschen oder ihre OS-Gruppe ändern.</p>
      <p><b>Riskante Befehle</b>: Jede Zeile, die ein Snippet oder Makro sendet, wird anhand der Regeln unter Einstellungen → Riskante Befehle geprüft. Befehle, die die Zeit oder NTP ändern (<code>timedatectl set-ntp</code>, <code>date -s</code>, <code>ntpdate</code>, <code>ntp server</code>, <code>clock set</code> …), werden <b>blockiert</b> und nie gesendet; Befehle wie Neustarts, Löschvorgänge, Formatierungen oder Änderungen der Gerätekonfiguration müssen zuerst in einer <b>Warnung</b> bestätigt werden. Beim Senden wird das Protokoll des Tabs eingeschaltet, und jeder Versuch, Abbruch und jede Blockierung wird in <code>risky-commands.log</code> im Protokollordner festgehalten. Geprüft werden auch mit <code>;</code> oder <code>&amp;&amp;</code> verkettete Befehle, Befehle innerhalb von <code>sudo</code>, <code>su -c</code>, <code>bash -c</code> oder <code>eval</code> sowie Zeilen, die mit einem <code>\\</code> am Zeilenende fortgesetzt werden. Makros mit Tab-Vervollständigung oder Cursortasten (←→, Home, Befehlsverlauf ↑↓) lösen eine Warnung aus, weil sich der tatsächlich gesendete Befehl nicht bestimmen lässt. Selbst eingegebene Befehle werden nicht geprüft.</p>
      <h4>Snippets erstellen und senden</h4>
      <ol>
        <li>In der Terminal-Symbolleiste: <b>Snippets</b> → <b>Snippets verwalten…</b> → <b>Neues Snippet</b>.</li>
        <li>Geben Sie einen Namen und den zu sendenden Inhalt ein. Mehrere Zeilen werden einzeln mit Enter gesendet (z. B. <code>terminal length 0</code> und in der nächsten Zeile <code>show running-config</code>).</li>
        <li>Ist <b>Nach dem Senden Enter drücken</b> aktiv, wird die letzte Zeile sofort ausgeführt; andernfalls wird der Befehl nur eingetippt und wartet.</li>
        <li>Zum Senden klicken Sie in der Symbolleiste auf <b>Snippets</b> und wählen es aus der Liste.</li>
      </ol>
      <h4>Makros aufzeichnen und abspielen</h4>
      <ol>
        <li>Klicken Sie in der Terminal-Symbolleiste auf <b>Aufnahme</b>; die Schaltfläche wechselt zu <b>Aufnahme beenden</b>, und jede ab dann getippte Taste wird unverändert gespeichert (inklusive Enter, Tab, Ctrl-Tasten, Pfeiltasten und IME-Eingabe).</li>
        <li>Geben Sie die Befehle wie gewohnt auf dem Gerät ein. Gesendete Snippets werden ebenfalls in das Makro aufgenommen.</li>
        <li>Klicken Sie auf <b>Aufnahme beenden</b> und geben Sie zum Speichern einen Namen ein.</li>
        <li>Zum Abspielen wählen Sie in der Symbolleiste aus der Liste <b>Snippets</b> den mit <b>Makro</b> gekennzeichneten Eintrag. Die aufgezeichneten Tasten werden der Reihe nach exakt wie getippt gesendet.</li>
      </ol>
      <ul>
        <li><b>Viele Geräte gleichzeitig</b>: Senden Sie ein Snippet oder Makro, während oben <b>Eingabe an alle</b> aktiv ist, dann geht es an jeden verbundenen Terminal-Tab.</li>
        <li><b>Keine Passwörter aufzeichnen</b>: Makros speichern Tasten exakt wie getippt, daher wird auch ein während der Aufnahme eingegebenes Passwort gespeichert.</li>
        <li>Den Inhalt von Makros sehen Sie unter <b>Snippets verwalten…</b> (⏎ = Enter, ⇥ = Tab, ^C = Ctrl+C). Umbenennen und Löschen sind möglich, die Tasten lassen sich aber nicht bearbeiten; zeichnen Sie das Makro zum Ändern neu auf.</li>
        <li>Snippets und Makros werden auf diesem PC gespeichert und von allen Sitzungen gemeinsam genutzt.</li>
      </ul>`,
  },
  {
    id: "monitor",
    title: "Geräteerkennung · CPU · Speicher",
    icon: "Activity",
    body: `
      <p>Wenn Sie sich per SSH oder Telnet verbinden, erkennt eine separate Überwachungsverbindung automatisch den Gerätetyp und zeigt Gerätenamen und CPU/Speicher (bei Servern auch Festplatten) in der Statusleiste an. Im Terminal wird nichts eingegeben.</p>
      <p>Unterstützte Geräte: <b>Cisco</b> IOS · IOS-XE · NX-OS · ASA, <b>Fortinet</b> FortiGate, <b>Aruba</b> AOS-CX · AOS-Switch (ProCurve) · WLAN-Controller, <b>Juniper</b> Junos, <b>Huawei</b> VRP sowie Server mit <b>Linux (Red Hat usw.)</b> · <b>AIX</b> · <b>HP-UX</b> · <b>Solaris</b>.</p>
      <ul>
        <li><b>Geräteschaltfläche</b>: Nach der Erkennung erscheint in der Terminal-Symbolleiste eine Schaltfläche mit dem Gerätenamen. Ein Klick darauf gibt häufige show-Befehle für dieses Gerät (Schnittstellen, Routing, VLAN, HA, Fehlerprotokolle usw.) in einem Schritt ein. Befehle, die die Konfiguration ändern, sind nicht enthalten.</li>
        <li><b>Konfiguration sichern</b>: Bei Netzwerkgeräten speichert Geräteschaltfläche → „Konfiguration sichern“ die running-config (<code>show</code> bei FortiGate) in einer Datei <code>devicename_datetime.cfg</code>. Gelesen wird über die Überwachungsverbindung, daher stört dies das Terminal, in dem Sie arbeiten, nicht. Verweigert das Gerät den Zugriff (fehlende Berechtigung) oder kommt das Ende der Konfiguration (<code>end</code> bei IOS, <code>return</code> bei Huawei usw.) nicht an, wird nichts gespeichert.</li>
        <li><b>Automatischer Tastaturmodus</b>: Wird ein Netzwerkgerät erkannt, wechseln Sitzungen ohne festgelegten Tastaturmodus in den Gerätemodus (Delete=Ctrl-D, Home=Ctrl-A, End=Ctrl-E).</li>
        <li><b>Top-Prozesse</b>: Klicken Sie in der Statusleiste auf CPU/Speicher, um die 10 Prozesse mit der höchsten CPU- und Speichernutzung sowie die Festplattenliste zu sehen (Linux).</li>
        <li>Die Überwachung verwendet eine zusätzliche Anmeldung. <b>Auch bei mehreren Tabs zum selben Gerät wird nur eine Überwachungsverbindung verwendet</b> (um die VTY-Leitungen des Geräts zu schonen).</li>
        <li>Abgefragt wird alle 2 Sekunden unter Linux (über Telnet alle 10 Sekunden), alle 15 Sekunden bei Netzwerkgeräten und alle 10 Sekunden unter AIX/HP-UX/Solaris. Die Überwachungsbefehle erscheinen nicht im Shell-Verlauf des Servers (<code>~/.sh_history</code> usw.). Die Abfrage pausiert, wenn kein Tab dieses Geräts sichtbar ist oder das Fenster minimiert ist (Geräte werden dann nur alle 5 Minuten geprüft, damit die Anmeldung nicht abbricht), und liest sofort, sobald es wieder angezeigt wird.</li>
        <li>Erscheint „Zum Anmelden klicken“, klicken Sie darauf und geben Sie das Passwort für die Überwachung ein (wird nicht gespeichert). Ist das Passwort nicht bekannt, trennt die Überwachungsverbindung, bevor der Benutzername gesendet wird, sodass auf dem Gerät keine fehlgeschlagene Anmeldung protokolliert wird. Bei einem Telnet-Gerät ohne Passwort lassen Sie das Passwort leer und starten. Fragt das Gerät nach der Anmeldung noch etwas ab, etwa einen Einmalcode, findet keine Überwachung statt. Zum Abschalten: Einstellungen → Sitzung.</li>
      </ul>`,
  },
  {
    id: "files",
    title: "Dateiübertragung (SFTP · FTP · FTPS)",
    icon: "FolderOpen",
    body: `
      <ul>
        <li>Links ist Ihr PC, rechts der Server. Ziehen Sie Elemente auf die andere Seite oder klicken Sie auf die Übertragungsschaltfläche. Ordner werden samt Inhalt übertragen.</li>
        <li>Existiert eine Datei mit gleichem Namen, werden Sie gefragt, ob sie überschrieben werden soll. Übertragungen zeigen ihren Fortschritt an und lassen sich abbrechen.</li>
        <li><b>TFTP</b>: Wählen Sie TFTP als Sitzungstyp (oder in der Schnellverbindung), um einen TFTP-Tab zu öffnen. TFTP hat weder Anmeldung noch Ordnerauflistung; geben Sie daher den <b>Dateinamen auf dem Server</b> ein und klicken Sie auf „Holen“, oder wählen Sie eine Datei auf Ihrem PC und klicken Sie auf „Senden“. Die Blockgröße „Auto“ passt für die meisten Geräte, und alte Server, die keine Optionen verstehen, fallen automatisch auf 512 zurück. Damit ein Gerät Dateien an Ihren PC senden kann (z. B. <code>copy running-config tftp:</code>), schalten Sie über die Schaltfläche „Server“ oben den <b>TFTP-Server</b> ein.</li>
        <li>Beim Senden eines Ordners über SFTP werden 4 Dateien gleichzeitig übertragen, was bei Ordnern mit vielen kleinen Dateien – besonders über große Entfernungen – deutlich schneller ist. FTP sendet wegen der Verbindungsgrenzen des Servers eine Datei nach der anderen, Sie können aber während der Übertragung weiter in Ordnern navigieren.</li>
        <li>Ein Doppelklick auf eine Textdatei auf dem Server öffnet sie im integrierten Editor; beim Speichern wird sie direkt auf den Server zurückgeschrieben.</li>
      </ul>`,
  },
  {
    id: "rdp",
    title: "Remotedesktop (RDP) · VNC",
    icon: "Monitor",
    body: `
      <ul>
        <li><b>Bildschirmgröße</b>: Ist die Auflösung der Sitzung „Automatisch“, passt sie sich der Tab-Größe an. Wenn Sie das Fenster vergrößern oder verkleinern, ändert sich auch die Remote-Auflösung; unterstützt der Server keine Größenänderung im laufenden Betrieb, wird automatisch mit der neuen Größe neu verbunden.</li>
        <li><b>Anpassen</b>: Legen Sie fest, ob der Remote-Bildschirm auf die Tab-Größe skaliert (ein) oder in Originalgröße angezeigt wird (aus).</li>
        <li><b>Kopieren &amp; Einfügen</b>: Wie bei mstsc tauschen Sie Text, Bilder sowie <b>Dateien und Ordner</b> zwischen Ihrem PC und dem Remote-PC mit ${kbd("Ctrl+C")} / ${kbd("Ctrl+V")} aus (Sitzungsoption „Zwischenablage teilen“). Auf der Remote-Seite kopierte Dateien werden beim Einfügen heruntergeladen, der Fortschritt wird in der Symbolleiste angezeigt.</li>
        <li>Tastatur: Tastaturtyp und -layout Ihres PCs (z. B. koreanische 103/106-Tasten-Tastatur) werden unverändert an die Remote-Seite übergeben, sodass rechte Shift/Ctrl/Alt-Taste und die Hangul/Hanja-Tasten wie in mstsc funktionieren. Der Zustand von Num Lock und Caps Lock wird auch auf dem Server angeglichen, sodass der Ziffernblock am Anmeldebildschirm funktioniert, ohne Num Lock erneut zu drücken.</li>
        <li>Symbolleiste: ${kbd("Ctrl+Alt+Del")} senden, Windows-Taste, Zwischenablage tippen (Text der Zwischenablage als Tastenanschläge senden), In mstsc öffnen.</li>
        <li>Bei der ersten Verbindung prüfen Sie den Fingerabdruck des Serverzertifikats; nach dem Vertrauen werden Sie nicht erneut gefragt.</li>
        <li>Während Sie einen anderen Tab ansehen oder das Fenster minimiert ist, zeichnet dieser RDP-Tab nicht, und bei der Rückkehr wird der gesamte Bildschirm auf einmal abgerufen.</li>
        <li><b>VNC-Geschwindigkeit</b>: Wählen Sie unter „Qualität“ in der Symbolleiste Schnell (Standard: weniger Farben/Qualität, maximale Kompression), Normal oder Scharf (wird sofort ohne Trennung angewendet). Schalten Sie „Status“ ein, um die vom Server verwendete Kodierung und die pro Sekunde empfangenen Daten zu sehen. Erscheinen nur Raw oder Hextile, verwendet der Server keine Kompression.</li>
        <li>Ist VNC langsam, liegt die Ursache meist in den <b>Servereinstellungen</b>. Für TightVNC Server: Verringern Sie unter Servereinstellungen → Registerkarte Server den <b>Screen polling cycle</b> von 1000ms auf 30–50ms, schalten Sie <b>Grab transparent windows</b> aus und aktivieren Sie den <b>Mirror-Treiber (DFMirage)</b>, falls installiert. Auch das Entfernen des Desktop-Hintergrunds hilft sehr. Auf großen Bildschirmen wie 4K kann TightVNC Dutzende Sekunden hinterherhinken (gemessen an einem PC: TightVNC 34–46 s Verzögerung, UltraVNC nahezu in Echtzeit). Verwenden Sie dann <b>UltraVNC Server</b> mit aktivierter Windows-Desktopduplizierung (DDengine) auf der Registerkarte Capture.</li>
        <li>Das integrierte RDP verwendet nicht die Grafikbeschleunigung von mstsc (H.264) und kann daher bei stark wechselnden Bildinhalten langsamer als mstsc sein. Verwenden Sie in diesem Fall „In mstsc öffnen“.</li>
      </ul>`,
  },
  {
    id: "tools",
    title: "Werkzeuge · Dateiserver",
    icon: "Waypoints",
    body: `
      <ul>
        <li><b>SSH-Gateway</b>: Wählen Sie im Sitzungseditor für RDP, VNC oder Telnet eine gespeicherte SSH-Sitzung als Gateway, um Geräte hinter einer Firewall über diesen Server zu erreichen.</li>
        <li><b>SSH-Tunnel</b>: Werkzeuge oben → SSH-Tunnel. Speichern Sie Weiterleitungen lokaler Port → SSH-Server → Zieladresse und schalten Sie sie ein und aus.</li>
        <li><b>Netzwerk-Tools</b>: Ping, TCP-Portprüfung (mehrere Ports und Bereiche), DNS-Abfrage.</li>
        <li><b>Dateiserver</b>: Die Dateiserver-Schaltfläche oben gibt einen Ordner dieses PCs vorübergehend per FTP, TFTP oder HTTP frei (z. B. zum Hochladen von Geräte-OS-Images).</li>
      </ul>`,
  },
  {
    id: "security",
    title: "Anmeldedaten · Sicherheit",
    icon: "KeyRound",
    body: `
      <ul>
        <li><b>Anmeldedaten-Tresor</b> (Schlüsselschaltfläche oben): Speichert Passwörter und SSH-Schlüssel in der Windows-Anmeldeinformationsverwaltung zur Verwendung im Sitzungseditor. Gespeicherte Passwörter werden nie auf dem Bildschirm angezeigt.</li>
        <li><b>Master-Passwort</b> (Einstellungen → Sicherheit): Sperrt die App beim Start und nach Abwesenheit.</li>
        <li>SSH/SFTP-Host-Schlüssel werden mit <code>~/.ssh/known_hosts</code> abgeglichen; bei unbekannten Schlüsseln wird zur Bestätigung ein Fingerabdruck angezeigt. Geänderte Schlüssel blockieren die Verbindung.</li>
      </ul>`,
  },
  {
    id: "update",
    title: "Updates",
    icon: "RefreshCw",
    body: `
      <p>Beim Start und <b>alle 30 Minuten</b> während der Ausführung (auch wenn Sie nach einer Weile zum Fenster zurückkehren) sucht die App auf <b>GitHub</b> (github.com/NijG/bananaconn) nach einer neuen Version. Auf einem PC, dessen Sicherheitsrichtlinie GitHub sperrt, geben Sie unter Einstellungen → Update einen <b>NAS-Updateordner</b> an (einen freigegebenen Ordner, in dem neue Versionen bereitgestellt werden); er wird geprüft, wenn GitHub nicht erreichbar ist. Wird eine neue Version gefunden, <b>fragt ein Fenster, ob jetzt aktualisiert werden soll</b>. „Jetzt aktualisieren“ schließt die App, installiert sie und öffnet sie wieder (offene Verbindungen werden getrennt). Mit „Später“ installiert die Schaltfläche <b>Aktualisieren</b> rechts in der Statusleiste sie jederzeit. Das Fenster öffnet sich mit „Später“ ausgewählt, sodass ein für ein Terminal getipptes Enter nie ein Update startet.</p>
      <p><b>Wenn es mit „Das Passwort ist falsch“ fehlschlägt</b>: Windows verbindet sich mit einem freigegebenen Ordner über das Windows-Konto, mit dem Sie angemeldet sind, und weicht nicht auf Gastzugriff aus, selbst wenn die Freigabe anonymes (Gast-)Lesen erlaubt. Öffnen Sie den Update-Ordner im Explorer, geben Sie das NAS-Konto ein und aktivieren Sie „Anmeldedaten speichern“, oder wählen Sie unter Einstellungen → Update bei <b>NAS-Konto</b> ein Konto aus dem Anmeldedaten-Tresor. Die App meldet sich dann damit an.</p>
      <p>Installiert werden nur vom Build-PC signierte Dateien, daher werden von anderen in den freigegebenen Ordner gelegte Dateien nicht installiert. Mit „Jetzt prüfen“ können Sie auch sofort suchen.</p>`,
  },
  {
    id: "keys",
    title: "Tastenkürzel",
    icon: "Keyboard",
    body: `
      <table class="help-table">
        <tr><td>${kbd("F1")}</td><td>Diese Hilfe (in einem Terminal geht die Taste an das entfernte Programm)</td></tr>
        <tr><td>${kbd("Ctrl+Shift+N")}</td><td>Neue Sitzung</td></tr>
        <tr><td>${kbd("Ctrl+Shift+K")}</td><td>Zur Schnellverbindung</td></tr>
        <tr><td>${kbd("Ctrl+Tab")} / ${kbd("Ctrl+Shift+Tab")}</td><td>Nächster / vorheriger Tab</td></tr>
        <tr><td>${kbd("Ctrl+F4")} · ${kbd("Ctrl+Shift+W")}</td><td>Tab schließen</td></tr>
        <tr><td>Doppelklick auf Tab</td><td>Dieselbe Sitzung erneut öffnen</td></tr>
        <tr><td>${kbd("Ctrl+Shift+F")}</td><td>Im Terminal suchen</td></tr>
        <tr><td>${kbd("Ctrl")}+Mausrad</td><td>Schriftgröße im Terminal</td></tr>
        <tr><td>${kbd("Ctrl+Shift+B")}</td><td>Seitenleiste einklappen</td></tr>
        <tr><td colspan="2"><b>In der Sitzungsliste</b></td></tr>
        <tr><td>${kbd("Enter")} / ${kbd("F2")} / ${kbd("Del")}</td><td>Verbinden / Bearbeiten / Löschen (gilt bei Mehrfachauswahl für alle)</td></tr>
        <tr><td>${kbd("Ctrl+C")} / ${kbd("Ctrl+V")}</td><td>Sitzungen kopieren / einfügen</td></tr>
        <tr><td>${kbd("Ctrl")}·${kbd("Shift")}+Klick, ${kbd("Ctrl+A")}</td><td>Mehrfachauswahl</td></tr>
      </table>`,
  },
];
