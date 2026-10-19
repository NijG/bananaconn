// French version of the in-app usage guide (same sections, ids and icons as help.ts).

import type { HelpSection } from "../help";
import { icon } from "../icons";
import { esc } from "../ui";

const kbd = (k: string) => k.split("+").map((p) => `<kbd>${esc(p)}</kbd>`).join("+");

export const SECTIONS: HelpSection[] = [
  {
    id: "start",
    title: "Premiers pas",
    icon: "Sparkles",
    body: `
      <p>BananaConn est un outil d'accès à distance qui regroupe dans des onglets les connexions SSH, Telnet, série (COM), SFTP, FTP/FTPS, RDP et VNC.</p>
      <h4>Se connecter tout de suite (Connexion rapide)</h4>
      <ol>
        <li>Choisissez un protocole (SSH, Telnet …) en haut à gauche.</li>
        <li>Saisissez <code>user@host:port</code> dans la zone voisine et appuyez sur ${kbd("Enter")}. Exemples : <code>root@10.0.0.5</code>, <code>admin@192.168.0.1:2222</code></li>
        <li>Pour une liaison série, saisissez <code>COM3</code> ou <code>COM3:115200</code>.</li>
      </ol>
      <h4>L'enregistrer comme session</h4>
      <p>Enregistrez les paramètres de connexion avec le bouton ${icon("Plus", 13)} de la liste des sessions (${kbd("Ctrl+Shift+N")}), puis connectez-vous par un double-clic ou avec ${kbd("Enter")}. Les connexions enregistrées dans d'autres programmes peuvent être reprises en une fois via <a data-goto="import">Importer</a>.</p>
      <h4>Langue de l'interface</h4>
      <p><b>Langue</b>, en haut des Paramètres, bascule l'interface en 한국어, English, 日本語, 简体中文, 繁體中文, Tiếng Việt, Español, Français ou Deutsch (immédiatement, sans déconnexion ; le guide et les notes de mise à jour suivent aussi). Tant que vous n'avez pas choisi, l'application suit la langue d'affichage de Windows ; une fois choisie, votre préférence l'emporte toujours.</p>`,
  },
  {
    id: "sessions",
    title: "Liste des sessions",
    icon: "Server",
    body: `
      <ul>
        <li><b>Dossiers</b> : dans l'éditeur de session, écrivez le dossier avec des barres obliques, comme <code>Prod/Serveurs web</code>, pour créer des sous-dossiers. Vous pouvez aussi faire glisser une session sur un dossier pour l'y déplacer.</li>
        <li><b>Recherche</b> : saisissez une partie d'un nom, d'un hôte, d'un utilisateur ou d'une note dans la zone de recherche en haut.</li>
        <li><b>Sélection multiple</b> : ${kbd("Ctrl")}+clic pour choisir un à un, ${kbd("Shift")}+clic pour choisir une plage. ${kbd("Shift+↑/↓")} et ${kbd("Ctrl+A")} fonctionnent aussi. ${kbd("Esc")} efface la sélection.</li>
        <li><b>Actions groupées</b> : avec plusieurs éléments sélectionnés, clic droit → Modification groupée (${kbd("F2")} : utilisateur, port, identifiant, dossier, mode clavier), Déplacer vers un dossier, Supprimer (${kbd("Del")}), Tout connecter (${kbd("Enter")}).</li>
        <li><b>Copier-coller</b> : sélectionnez une session et appuyez sur ${kbd("Ctrl+C")}, sélectionnez une session dans le dossier cible et appuyez sur ${kbd("Ctrl+V")}. Chaque collage crée une nouvelle session nommée « Nom (2) », « Nom (3) ». Clic droit → Dupliquer fait de même.</li>
        <li><b>Modifier</b> : ${kbd("F2")} ou clic droit → Modifier.</li>
      </ul>`,
  },
  {
    id: "import",
    title: "Importer depuis d'autres programmes",
    icon: "Download",
    body: `
      <p>Choisissez dans le bouton ${icon("Download", 13)} au-dessus de la liste des sessions. Un aperçu est affiché avant l'importation, et les sessions existantes sont ignorées. <b>Les mots de passe ne sont pas importés</b> (chaque programme les chiffre avec sa propre clé). Saisissez-les à la première connexion ou attribuez-en un depuis le coffre d'identifiants.</p>
      <table class="help-table">
        <tr><th>Programme</th><th>Quoi choisir</th></tr>
        <tr><td>MobaXterm</td><td><code>%APPDATA%\\MobaXterm\\MobaXterm.ini</code> (version portable : à côté de l'exécutable)</td></tr>
        <tr><td>SecureCRT</td><td>Le dossier de sessions <code>%APPDATA%\\VanDyke\\Config\\Sessions</code> (y compris l'arborescence, les noms de fichiers journaux et les réglages de journalisation automatique), ou un XML créé via Fichier → Exporter les paramètres</td></tr>
        <tr><td>mRemoteNG</td><td><code>%APPDATA%\\mRemoteNG\\confCons.xml</code> (si le chiffrement complet du fichier est activé, désactivez-le et enregistrez d'abord)</td></tr>
        <tr><td>PuTTY · KiTTY</td><td>Lit directement les paramètres de ce PC</td></tr>
        <tr><td>WinSCP</td><td>Les paramètres de ce PC, ou <code>WinSCP.ini</code> à défaut</td></tr>
        <tr><td>Xshell</td><td>Le dossier <code>Documents\\NetSarang Computer\\&lt;version&gt;\\Xshell\\Sessions</code></td></tr>
        <tr><td>RDCMan</td><td>Fichier <code>.rdg</code></td></tr>
        <tr><td>Bureau à distance</td><td>Un dossier contenant des fichiers <code>.rdp</code> (sous-dossiers inclus)</td></tr>
        <tr><td>CSV</td><td>Noms de colonnes sur la première ligne : Name, Protocol, Host, Port, Username, Folder (séparés par virgule, point-virgule ou tabulation)</td></tr>
      </table>
      <p>Entre deux installations de BananaConn, utilisez <b>Exporter/Importer une sauvegarde de sessions (JSON)</b> dans le même menu. La sauvegarde contient, outre les sessions, les dossiers vides, les extraits/macros et les tunnels SSH. Une restauration sur le même PC conserve les liens vers les identifiants, et même si toutes les sessions existent déjà, vous pouvez restaurer uniquement les dossiers, extraits et tunnels manquants. Les tunnels SSH et les options liées à la sécurité (ignorer les erreurs de certificat, redirection de ports, emplacement du fichier journal, etc.) ne sont importés que si « Importer aussi les options liées à la sécurité » est activé.</p>`,
  },
  {
    id: "tabs",
    title: "Onglets et affichage partagé",
    icon: "LayoutGrid",
    body: `
      <ul>
        <li><b>Fermer un onglet</b> : ${kbd("Ctrl+F4")} ou ${kbd("Ctrl+Shift+W")}, ou clic du milieu sur l'onglet. Appuyez sur ${kbd("Enter")} dans la confirmation pour fermer ; cochez « Ne plus demander » pour l'éviter la prochaine fois (réactivable dans Paramètres).</li>
        <li><b>Rouvrir la même session</b> : <b>double-cliquez</b> sur l'onglet. Pratique pour une seconde connexion au même équipement afin de le surveiller.</li>
        <li><b>Changer d'onglet</b> : ${kbd("Ctrl+Tab")} / ${kbd("Ctrl+Shift+Tab")}. Avec beaucoup d'onglets, faites tourner la molette sur la barre d'onglets pour vous déplacer à gauche et à droite. Faites glisser les onglets pour les réorganiser.</li>
        <li><b>Affichage partagé</b> : les boutons vue unique / côte à côte / haut et bas / quatre volets en haut. Faites glisser un onglet dans le volet voulu.</li>
        <li>La couleur du point de l'onglet indique le protocole ; un clignotement signifie une connexion en cours, et le rouge une erreur.</li>
      </ul>`,
  },
  {
    id: "terminal",
    title: "Terminal (SSH · Telnet · Série)",
    icon: "SquareTerminal",
    body: `
      <ul>
        <li><b>Copier-coller</b> : sélectionner en faisant glisser copie immédiatement, et le clic droit colle (réglable dans Paramètres). ${kbd("Ctrl+C")} ne copie que s'il y a une sélection ; sinon il est envoyé à l'équipement.</li>
        <li><b>Taille de police</b> : ${kbd("Ctrl")}+molette, ou ${icon("ZoomIn", 13)}${icon("ZoomOut", 13)} dans la barre d'outils.</li>
        <li><b>Rechercher</b> : ${kbd("Ctrl+Shift+F")}.</li>
        <li><b>Mode clavier</b> : si Delete, Home ou End affichent <code>~</code> sur des équipements comme Cisco IOS, passez la barre d'outils sur « Touches : Équipement » (Delete=Ctrl-D, Home=Ctrl-A, End=Ctrl-E). Vous pouvez définir la valeur par défaut dans l'éditeur de session.</li>
        <li><b>Série</b> : dans l'éditeur de session, réglez le port COM (« Rechercher les ports »), la vitesse, la parité et le contrôle de flux. Break dans la barre d'outils envoie un signal Break. Un collage de plusieurs lignes est envoyé ligne par ligne avec un court intervalle pour que l'équipement ne perde pas de caractères ; ${kbd("Ctrl+C")} ou Break arrête l'envoi des lignes restantes.</li>
        <li><b>Mise en évidence des mots-clés de la sortie</b> : ERROR·FAIL en rouge, WARN en jaune, OK·SUCCESS en vert.</li>
        <li><b>Rendu</b> (Paramètres → Terminal) : « Auto » dessine avec le GPU (WebGL) sur les PC dotés d'une carte graphique, ce qui accélère les sorties volumineuses, et utilise le rendu standard sur les serveurs et sessions distantes qui n'en ont pas. Seuls les terminaux visibles à l'écran utilisent le GPU.</li>
        <li><b>Extraits et macros</b> : enregistrez les commandes fréquentes sous Extraits dans la barre d'outils, et utilisez « Enregistrer » pour capturer une saisie et la rejouer.</li>
        <li><b>Fichiers</b> (SSH) : le bouton Fichiers de la barre d'outils ouvre à côté un volet SFTP du même serveur.</li>
      </ul>`,
  },
  {
    id: "broadcast",
    title: "Saisie simultanée",
    icon: "Radio",
    body: `
      <p>Activez <b>Saisie simultanée</b> en haut : les touches tapées dans le terminal actuel sont envoyées à <b>tous les onglets de terminal connectés</b> (y compris ceux qui ne sont pas à l'écran). Les onglets destinataires ont un point clignotant. Utilisez-la pour envoyer la même commande à plusieurs équipements, et pensez à la désactiver ensuite. Chaque onglet envoie Delete, Home et End selon son propre mode clavier (standard/équipement).</p>`,
  },
  {
    id: "log",
    title: "Journalisation des sessions",
    icon: "ScrollText",
    body: `
      <p>Démarrez et arrêtez avec le bouton <b>Journal</b> de la barre d'outils. Au démarrage, vous pouvez vérifier et modifier le nom du fichier (désactivable dans Paramètres), et un clic sur « Journalisation en cours » dans la barre d'état ouvre le dossier contenant le fichier.</p>
      <h4>Variables du nom de fichier (identiques à SecureCRT)</h4>
      <table class="help-table">
        <tr><td><code>%S</code> nom de session</td><td><code>%H</code> hôte</td><td><code>%U</code> utilisateur</td><td><code>%P</code> port</td></tr>
        <tr><td><code>%Y</code> année (4 chiffres)</td><td><code>%M</code> mois</td><td><code>%D</code> jour</td><td><code>%%</code> signe %</td></tr>
        <tr><td><code>%h</code> heure</td><td><code>%m</code> minute</td><td><code>%s</code> seconde</td><td><code>%t</code> milliseconde</td></tr>
      </table>
      <p>Exemple : <code>D:\\Checks\\CRT_Log\\%S (%H)_%Y%M%D.log</code> → <code>D:\\Checks\\CRT_Log\\SERVER01 (10.1.1.5)_20261015.log</code>. Les dossiers manquants sont créés. Les chemins relatifs sont placés sous Documents\\BananaConn\\logs.</p>
      <ul>
        <li><b>Si le fichier existe</b> : Ajouter / Écraser / Nouveau fichier (-2, -3 …).</li>
        <li><b>Préfixe de ligne</b> : par ex. <code>[%h:%m:%s] </code> pour horodater chaque ligne.</li>
        <li><b>Au début / à la fin</b> : texte à écrire dans le fichier (variables autorisées).</li>
        <li><b>Nouveau fichier après minuit</b> : si le nom contient <code>%D</code>, la journalisation continue dans un nouveau fichier au changement de date.</li>
        <li><b>Journaliser automatiquement à la connexion</b> : pour toutes les sessions (Paramètres → Journaux) ou par session (éditeur de session → Journal → Cette session uniquement).</li>
      </ul>`,
  },
  {
    id: "macros",
    title: "Extraits · Macros",
    icon: "Circle",
    body: `
      <p>Enregistrez les commandes fréquentes (extraits), ou enregistrez les touches tapées dans un terminal pour les renvoyer à l'identique (macros).</p>
      <p><b>Extraits intégrés par OS</b> : vérifications courantes en lecture seule (commandes qui ne modifient rien) pour Linux, AIX, HP-UX, Solaris, Windows, Cisco IOS · NX-OS · ASA, FortiGate, Aruba, Juniper et Huawei. La liste des extraits affiche d'abord vos propres extraits et ceux de l'OS reconnu dans cet onglet ; les autres systèmes sont à un clic sous « Extraits … ». Modifiez-les, supprimez-les ou changez leur groupe d'OS dans Gérer les extraits.</p>
      <p><b>Commandes à risque</b> : chaque ligne envoyée par un extrait ou une macro est vérifiée selon les règles de Paramètres → Commandes à risque. Les commandes qui modifient l'heure ou NTP (<code>timedatectl set-ntp</code>, <code>date -s</code>, <code>ntpdate</code>, <code>ntp server</code>, <code>clock set</code> …) sont <b>bloquées</b> et jamais envoyées ; les commandes telles que redémarrages, suppressions, formatages ou modifications de la configuration de l'équipement doivent d'abord être confirmées dans un <b>avertissement</b>. À l'envoi, le journal de l'onglet est activé, et chaque tentative, annulation et blocage est consigné dans <code>risky-commands.log</code> dans le dossier de journaux. Sont aussi vérifiées les commandes enchaînées avec <code>;</code> ou <code>&amp;&amp;</code>, les commandes passées à <code>sudo</code>, <code>su -c</code>, <code>bash -c</code> ou <code>eval</code>, et les lignes prolongées par un <code>\\</code> final. Les macros contenant une complétion par Tab ou des touches de curseur (←→, Home, historique ↑↓) déclenchent un avertissement, car la commande réellement envoyée ne peut pas être connue. Les commandes que vous tapez vous-même ne sont pas vérifiées.</p>
      <h4>Créer et envoyer des extraits</h4>
      <ol>
        <li>Dans la barre d'outils du terminal : <b>Extraits</b> → <b>Gérer les extraits…</b> → <b>Nouvel extrait</b>.</li>
        <li>Saisissez un nom et le contenu à envoyer. Les lignes multiples sont envoyées une à une avec Enter (par ex. <code>terminal length 0</code> suivi de <code>show running-config</code> sur la ligne suivante).</li>
        <li>Avec <b>Appuyer sur Enter après l'envoi</b> activé, la dernière ligne s'exécute aussitôt ; désactivé, la commande est seulement tapée et attend.</li>
        <li>Pour en envoyer un, cliquez sur <b>Extraits</b> dans la barre d'outils et choisissez-le dans la liste.</li>
      </ol>
      <h4>Enregistrer et rejouer des macros</h4>
      <ol>
        <li>Cliquez sur <b>Enregistrer</b> dans la barre d'outils du terminal ; le bouton devient <b>Arrêter l'enregistrement</b> et chaque touche tapée ensuite est enregistrée telle quelle (y compris Enter, Tab, les touches Ctrl, les flèches et la saisie IME).</li>
        <li>Tapez vos commandes sur l'équipement comme d'habitude. Les extraits envoyés sont aussi enregistrés dans la macro.</li>
        <li>Cliquez sur <b>Arrêter l'enregistrement</b> et donnez-lui un nom pour l'enregistrer.</li>
        <li>Pour la rejouer, choisissez l'élément marqué <b>Macro</b> dans la liste <b>Extraits</b> de la barre d'outils. Les touches enregistrées sont envoyées dans l'ordre, exactement comme tapées.</li>
      </ol>
      <ul>
        <li><b>Plusieurs équipements à la fois</b> : envoyez un extrait ou une macro alors que la <b>Saisie simultanée</b> est activée en haut, et il part vers tous les onglets de terminal connectés.</li>
        <li><b>N'enregistrez pas de mots de passe</b> : les macros stockent les touches telles que tapées, donc un mot de passe saisi pendant l'enregistrement est lui aussi enregistré.</li>
        <li>Vous pouvez voir le contenu des macros dans <b>Gérer les extraits…</b> (⏎ = Enter, ⇥ = Tab, ^C = Ctrl+C). Le renommage et la suppression sont possibles, mais les touches ne sont pas modifiables ; réenregistrez la macro pour la changer.</li>
        <li>Les extraits et macros sont stockés sur ce PC et partagés par toutes les sessions.</li>
      </ul>`,
  },
  {
    id: "monitor",
    title: "Détection d'équipement · CPU · Mémoire",
    icon: "Activity",
    body: `
      <p>Lorsque vous vous connectez en SSH ou Telnet, une connexion de surveillance distincte détecte automatiquement le type d'équipement et affiche son nom et le CPU/la mémoire (plus le disque pour les serveurs) dans la barre d'état. Rien n'est saisi dans le terminal.</p>
      <p>Équipements pris en charge : <b>Cisco</b> IOS · IOS-XE · NX-OS · ASA, <b>Fortinet</b> FortiGate, <b>Aruba</b> AOS-CX · AOS-Switch (ProCurve) · contrôleurs sans fil, <b>Juniper</b> Junos, <b>Huawei</b> VRP, et serveurs sous <b>Linux (Red Hat etc.)</b> · <b>AIX</b> · <b>HP-UX</b> · <b>Solaris</b>.</p>
      <ul>
        <li><b>Bouton d'équipement</b> : une fois l'équipement détecté, un bouton portant son nom apparaît dans la barre d'outils du terminal. Cliquez dessus pour saisir en une fois les commandes show courantes de cet équipement (interfaces, routage, VLAN, HA, journaux d'erreurs, etc.). Aucune commande modifiant la configuration n'est incluse.</li>
        <li><b>Sauvegarder la configuration</b> : pour les équipements réseau, bouton d'équipement → « Sauvegarder la configuration » enregistre la running-config (<code>show</code> sur FortiGate) dans un fichier <code>devicename_datetime.cfg</code>. La lecture passe par la connexion de surveillance et ne perturbe donc pas le terminal dans lequel vous travaillez. Rien n'est enregistré si l'équipement refuse (droits insuffisants) ou si la fin de la configuration (<code>end</code> sous IOS, <code>return</code> sous Huawei, etc.) n'arrive pas.</li>
        <li><b>Mode clavier automatique</b> : lorsqu'un équipement réseau est détecté, les sessions sans mode clavier choisi passent en mode équipement (Delete=Ctrl-D, Home=Ctrl-A, End=Ctrl-E).</li>
        <li><b>Processus principaux</b> : cliquez sur CPU/mémoire dans la barre d'état pour voir les 10 processus les plus gourmands en CPU et en mémoire ainsi que la liste des disques (Linux).</li>
        <li>La surveillance utilise une connexion supplémentaire. <b>Même avec plusieurs onglets ouverts sur le même équipement, une seule connexion de surveillance est utilisée</b> (pour économiser les lignes VTY de l'équipement).</li>
        <li>L'interrogation a lieu toutes les 2 secondes sous Linux (10 secondes via Telnet), 15 secondes sur les équipements réseau et 10 secondes sous AIX/HP-UX/Solaris. Les commandes de surveillance n'apparaissent pas dans l'historique du shell du serveur (<code>~/.sh_history</code>, etc.). Elle se met en pause lorsqu'aucun onglet de cet équipement n'est à l'écran ou que la fenêtre est réduite (les équipements ne sont alors vérifiés qu'une fois toutes les 5 minutes pour que la connexion ne tombe pas), et reprend immédiatement à l'affichage.</li>
        <li>Si « Cliquez pour vous connecter » apparaît, cliquez et saisissez le mot de passe pour la surveillance (non enregistré). Si le mot de passe n'est pas connu, la connexion de surveillance raccroche avant d'envoyer le nom d'utilisateur : aucun échec de connexion n'est donc enregistré sur l'équipement. Pour un équipement Telnet accessible sans mot de passe, laissez le mot de passe vide et démarrez. Si l'équipement demande autre chose après la connexion, comme un code à usage unique, la surveillance ne s'exécute pas. Pour la désactiver : Paramètres → Session.</li>
      </ul>`,
  },
  {
    id: "files",
    title: "Transfert de fichiers (SFTP · FTP · FTPS)",
    icon: "FolderOpen",
    body: `
      <ul>
        <li>Le côté gauche est votre PC et le côté droit le serveur. Faites glisser les éléments vers l'autre côté ou cliquez sur le bouton de transfert. Les dossiers sont envoyés avec leur contenu.</li>
        <li>Si un fichier du même nom existe, il vous est demandé s'il faut l'écraser. Les transferts affichent leur progression et peuvent être annulés.</li>
        <li><b>TFTP</b> : choisissez TFTP comme type de session (ou dans Connexion rapide) pour ouvrir un onglet TFTP. TFTP n'a ni connexion ni liste de dossiers : saisissez le <b>nom du fichier sur le serveur</b> et cliquez sur « Récupérer », ou choisissez un fichier sur votre PC et cliquez sur « Envoyer ». La taille de bloc « Auto » convient à la plupart des équipements, et les anciens serveurs qui ne comprennent pas les options reviennent automatiquement à 512. Pour qu'un équipement envoie des fichiers vers votre PC (par ex. <code>copy running-config tftp:</code>), activez le <b>serveur TFTP</b> sous le bouton « Serveurs » en haut.</li>
        <li>L'envoi d'un dossier en SFTP transfère 4 fichiers à la fois, ce qui est bien plus rapide pour les dossiers contenant beaucoup de petits fichiers, surtout sur de longues distances. FTP envoie un fichier à la fois à cause des limites de connexion des serveurs, mais vous pouvez continuer à parcourir les dossiers pendant le transfert.</li>
        <li>Double-cliquez sur un fichier texte du serveur pour l'ouvrir dans l'éditeur intégré ; l'enregistrement le réécrit directement sur le serveur.</li>
      </ul>`,
  },
  {
    id: "rdp",
    title: "Bureau à distance (RDP) · VNC",
    icon: "Monitor",
    body: `
      <ul>
        <li><b>Taille d'écran</b> : si la résolution de la session est « Auto », elle suit la taille de l'onglet. Redimensionner la fenêtre redimensionne aussi la résolution distante, et si le serveur ne prend pas en charge le redimensionnement à la volée, la reconnexion se fait automatiquement à la nouvelle taille.</li>
        <li><b>Ajuster</b> : choisissez de mettre l'écran distant à l'échelle de l'onglet (activé) ou de l'afficher en taille réelle (désactivé).</li>
        <li><b>Copier-coller</b> : comme avec mstsc, échangez du texte, des images et des <b>fichiers et dossiers</b> entre votre PC et le PC distant avec ${kbd("Ctrl+C")} / ${kbd("Ctrl+V")} (option de session « Partager le presse-papiers »). Les fichiers copiés côté distant sont téléchargés au moment du collage, avec la progression affichée dans la barre d'outils.</li>
        <li>Clavier : le type et la disposition du clavier de votre PC (par ex. coréen 103/106 touches) sont transmis tels quels, de sorte que Shift/Ctrl/Alt droits et les touches Hangul/Hanja se comportent comme dans mstsc. L'état de Num Lock et de Caps Lock est aussi aligné sur le serveur : le pavé numérique fonctionne à l'écran d'ouverture de session sans rappuyer sur Num Lock.</li>
        <li>Barre d'outils : envoyer ${kbd("Ctrl+Alt+Del")}, touche Windows, Saisir le presse-papiers (envoie le texte du presse-papiers sous forme de frappes), Ouvrir dans mstsc.</li>
        <li>À la première connexion, vous vérifiez l'empreinte du certificat du serveur ; une fois approuvé, la question ne sera plus posée.</li>
        <li>Pendant que vous consultez un autre onglet ou que la fenêtre est réduite, l'onglet RDP cesse de dessiner, puis récupère l'écran complet en une fois à votre retour.</li>
        <li><b>Vitesse VNC</b> : sous « Qualité » dans la barre d'outils, choisissez Rapide (par défaut : couleurs/qualité réduites, compression maximale), Équilibrée ou Nette (appliqué immédiatement sans déconnexion). Activez « Statistiques de transfert » pour voir l'encodage utilisé par le serveur et les données reçues par seconde. Si seuls Raw ou Hextile apparaissent, le serveur n'utilise pas de compression.</li>
        <li>Quand VNC est lent, la cause est généralement la <b>configuration du serveur</b>. Pour TightVNC Server : dans les paramètres du serveur → onglet Server, réduisez le <b>Screen polling cycle</b> de 1000ms à 30–50ms, désactivez <b>Grab transparent windows</b> et activez le <b>mirror driver (DFMirage)</b> s'il est installé. Supprimer le fond d'écran aide aussi beaucoup. Sur les grands écrans comme le 4K, TightVNC peut accumuler des dizaines de secondes de retard (mesuré sur un PC : TightVNC 34–46 s de retard, UltraVNC presque en temps réel). Utilisez alors <b>UltraVNC Server</b>, avec la duplication du bureau Windows (DDengine) activée dans son onglet Capture.</li>
        <li>Le RDP intégré n'utilise pas l'accélération graphique de mstsc (H.264) ; il peut donc être plus lent que mstsc lorsque l'écran change beaucoup. Dans ce cas, utilisez « Ouvrir dans mstsc ».</li>
      </ul>`,
  },
  {
    id: "tools",
    title: "Outils · Serveurs de fichiers",
    icon: "Waypoints",
    body: `
      <ul>
        <li><b>Passerelle SSH</b> : dans l'éditeur de session RDP, VNC ou Telnet, choisissez une session SSH enregistrée comme passerelle pour atteindre, via ce serveur, des équipements situés derrière un pare-feu.</li>
        <li><b>Tunnels SSH</b> : Outils en haut → Tunnels SSH. Enregistrez des redirections port local → serveur SSH → adresse cible et activez-les ou désactivez-les.</li>
        <li><b>Outils réseau</b> : ping, vérification de ports TCP (plusieurs ports et plages), recherche DNS.</li>
        <li><b>Serveurs de fichiers</b> : le bouton de serveur de fichiers en haut partage temporairement un dossier de ce PC via FTP, TFTP ou HTTP (par ex. pour envoyer des images d'OS d'équipements).</li>
      </ul>`,
  },
  {
    id: "security",
    title: "Identifiants · Sécurité",
    icon: "KeyRound",
    body: `
      <ul>
        <li><b>Coffre d'identifiants</b> (bouton clé en haut) : stocke les mots de passe et clés SSH dans le Gestionnaire d'identification Windows pour les utiliser dans l'éditeur de session. Les mots de passe enregistrés ne sont jamais affichés à l'écran.</li>
        <li><b>Mot de passe principal</b> (Paramètres → Sécurité) : verrouille l'application au démarrage et après une absence.</li>
        <li>Les clés d'hôte SSH/SFTP sont vérifiées par rapport à <code>~/.ssh/known_hosts</code> ; une clé inconnue affiche une empreinte à confirmer. Une clé modifiée bloque la connexion.</li>
      </ul>`,
  },
  {
    id: "update",
    title: "Mises à jour",
    icon: "RefreshCw",
    body: `
      <p>Définissez un <b>dossier de mise à jour</b> (dossier partagé où sont placées les nouvelles versions) dans Paramètres → Mises à jour : l'application recherche une nouvelle version au démarrage et <b>toutes les 30 minutes</b> pendant son exécution (ainsi qu'à votre retour sur la fenêtre après une absence). Lorsqu'une nouvelle version est trouvée, <b>une invite vous demande s'il faut mettre à jour maintenant</b>. Cliquez sur « Mettre à jour » : l'application se ferme, s'installe et se rouvre (les connexions ouvertes sont coupées). Cliquez sur « Plus tard » pour installer quand vous voulez avec le bouton <b>Mettre à jour</b> à droite de la barre d'état. L'invite a « Plus tard » sélectionné au départ, de sorte qu'un Enter que vous tapiez dans un terminal ne lance pas la mise à jour.</p>
      <p><b>En cas d'échec « le mot de passe est incorrect »</b> : Windows se connecte à un dossier partagé avec le compte Windows de la session ouverte, et ne bascule pas vers l'accès invité même si le partage autorise la lecture anonyme (invité). Ouvrez le dossier de mise à jour dans l'Explorateur, saisissez le compte NAS et cochez « Mémoriser mes informations d'identification », ou choisissez un compte du coffre d'identifiants sous <b>Compte NAS</b> dans Paramètres → Mises à jour. L'application s'y connecte alors avec ce compte.</p>
      <p>Seuls les fichiers signés par le PC de build sont installés : les fichiers déposés dans le dossier partagé par d'autres personnes ne le sont pas. Vous pouvez aussi vérifier immédiatement avec « Vérifier maintenant ».</p>`,
  },
  {
    id: "keys",
    title: "Raccourcis clavier",
    icon: "Keyboard",
    body: `
      <table class="help-table">
        <tr><td>${kbd("F1")}</td><td>Cette aide (dans un terminal, la touche est transmise au programme distant)</td></tr>
        <tr><td>${kbd("Ctrl+Shift+N")}</td><td>Nouvelle session</td></tr>
        <tr><td>${kbd("Ctrl+Shift+K")}</td><td>Aller à Connexion rapide</td></tr>
        <tr><td>${kbd("Ctrl+Tab")} / ${kbd("Ctrl+Shift+Tab")}</td><td>Onglet suivant / précédent</td></tr>
        <tr><td>${kbd("Ctrl+F4")} · ${kbd("Ctrl+Shift+W")}</td><td>Fermer l'onglet</td></tr>
        <tr><td>Double-clic sur l'onglet</td><td>Rouvrir la même session</td></tr>
        <tr><td>${kbd("Ctrl+Shift+F")}</td><td>Rechercher dans le terminal</td></tr>
        <tr><td>${kbd("Ctrl")}+molette</td><td>Taille de police du terminal</td></tr>
        <tr><td>${kbd("Ctrl+Shift+B")}</td><td>Réduire la barre latérale</td></tr>
        <tr><td colspan="2"><b>Dans la liste des sessions</b></td></tr>
        <tr><td>${kbd("Enter")} / ${kbd("F2")} / ${kbd("Del")}</td><td>Se connecter / Modifier / Supprimer (s'applique à toutes lorsque plusieurs sont sélectionnées)</td></tr>
        <tr><td>${kbd("Ctrl+C")} / ${kbd("Ctrl+V")}</td><td>Copier / coller des sessions</td></tr>
        <tr><td>${kbd("Ctrl")}·${kbd("Shift")}+clic, ${kbd("Ctrl+A")}</td><td>Sélection multiple</td></tr>
      </table>`,
  },
];
