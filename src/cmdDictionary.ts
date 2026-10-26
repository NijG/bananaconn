// Common read-mostly commands per operating system, for command-line
// suggestions (cmdLine.ts) after the user's own history and snippets. Keys are
// the snippet library's group names (snippetLibrary.ts groupForKind).
// Commands that a risk rule matches are filtered out when suggested, so the
// lists may stay plain.

const UNIX_BUILTINS = ["cd ", "export ", "echo ", "history", "alias", "source ", "exit", "pwd", "which ", "type ", "ulimit -a", "umask"];

export const COMMAND_DICTIONARY: Record<string, string[]> = {
  Linux: [
    ...UNIX_BUILTINS,
    "systemctl status ", "systemctl list-units --type=service --state=running", "systemctl --failed", "systemctl is-active ", "systemctl cat ",
    "journalctl -u ", "journalctl -xe", "journalctl -f", "journalctl --since today -p err", "journalctl -k -b",
    "ip addr show", "ip -br addr", "ip route show", "ip -s link", "ip neigh show",
    "ss -tulpn", "ss -s", "netstat -tulpn", "ping -c 4 ", "traceroute ", "curl -I ", "dig +short ", "nslookup ",
    "df -hT", "du -sh *", "lsblk -f", "mount | column -t", "findmnt", "free -m", "vmstat 1 5", "iostat -xz 1 5", "sar -u 1 5",
    "top -b -n 1 | head -n 20", "ps -ef --sort=-%cpu | head", "ps aux --sort=-rss | head", "uptime", "uname -a", "hostnamectl",
    "cat /etc/os-release", "lscpu", "dmesg -T | tail -n 50", "last -n 20", "who", "w", "id ", "getent passwd ",
    "tail -f /var/log/messages", "tail -f /var/log/syslog", "grep -i error ", "find / -name ", "ls -la", "ls -ltr",
    "rpm -qa | grep ", "dnf list installed ", "apt list --installed | grep ", "crontab -l", "firewall-cmd --list-all",
    "getenforce", "nmcli device status", "timedatectl status", "chronyc tracking", "lsof -i :",
  ],
  AIX: [
    ...UNIX_BUILTINS,
    "oslevel -s", "prtconf", "lsattr -El sys0", "lsdev -Cc disk", "lspv", "lsvg -o", "lsvg -l rootvg", "lsvg rootvg", "lslv ",
    "lsps -a", "lslpp -l ", "instfix -i | grep ML", "errpt | head -n 20", "errpt -a | more", "svmon -G", "vmstat 1 5", "iostat 1 5",
    "topas", "netstat -rn", "netstat -in", "entstat -d ent0", "ifconfig -a", "lssrc -a", "lssrc -s ", "df -g", "uptime", "who -b",
    "ps -ef | grep ", "lsuser ", "bootlist -m normal -o", "lsmcode -A", "tail -f /var/adm/messages",
  ],
  "HP-UX": [
    ...UNIX_BUILTINS,
    "bdf", "machinfo", "model", "uname -a", "swlist", "swlist -l product | grep ", "ioscan -fnC disk", "ioscan -fnC lan",
    "vgdisplay -v ", "lvdisplay ", "pvdisplay ", "lanscan", "netstat -rn", "netstat -in", "sar -u 1 5", "vmstat 1 5", "glance",
    "cmviewcl -v", "ps -ef | grep ", "tail -f /var/adm/syslog/syslog.log", "dmesg | tail", "kctune", "who -b", "uptime",
  ],
  Solaris: [
    ...UNIX_BUILTINS,
    "uname -a", "prtconf | head", "psrinfo -v", "prtdiag -v", "svcs -xv", "svcs -a | grep ", "zpool status", "zfs list", "df -h",
    "dladm show-link", "ipadm show-addr", "netstat -rn", "vmstat 1 5", "iostat -xn 1 5", "prstat -a", "zoneadm list -cv", "pkg list | grep ",
  ],
  Windows: [
    "Get-Service | Where-Object Status -eq Running", "Get-Process | Sort-Object CPU -Descending | Select-Object -First 10", "Get-EventLog -LogName System -Newest 50",
    "Get-WinEvent -LogName System -MaxEvents 50", "Get-NetIPAddress", "Get-NetTCPConnection -State Listen", "Test-NetConnection ", "Get-Volume",
    "Get-ComputerInfo", "Get-HotFix", "Get-Content -Wait ", "ipconfig /all", "netstat -ano", "tasklist", "systeminfo", "whoami /all", "nslookup ", "tracert ",
  ],
  "Cisco IOS": [
    "show running-config", "show running-config interface ", "show startup-config", "show version", "show ip interface brief", "show interfaces status",
    "show interfaces ", "show interfaces counters errors", "show vlan brief", "show mac address-table", "show mac address-table address ", "show ip route",
    "show ip arp", "show cdp neighbors", "show cdp neighbors detail", "show lldp neighbors", "show spanning-tree summary", "show etherchannel summary",
    "show logging", "show inventory", "show environment all", "show processes cpu sorted", "show processes memory sorted", "show clock", "show ntp status",
    "show users", "show power inline", "show port-security", "show access-lists", "show ip ospf neighbor", "show ip bgp summary", "show standby brief",
    "terminal length 0", "ping ", "traceroute ", "interface ", "description ", "switchport mode access", "switchport access vlan ", "switchport mode trunk",
    "switchport trunk allowed vlan ", "shutdown", "no shutdown", "write memory", "exit", "end",
  ],
  "Cisco NX-OS": [
    "show running-config", "show version", "show interface brief", "show interface status", "show vlan brief", "show mac address-table", "show ip route",
    "show ip arp", "show cdp neighbors", "show lldp neighbors", "show port-channel summary", "show vpc brief", "show logging last 50", "show module",
    "show environment", "show system resources", "show processes cpu sort", "show hsrp brief", "terminal length 0", "ping ", "traceroute ",
  ],
  "Cisco ASA": [
    "show running-config", "show version", "show interface ip brief", "show route", "show conn count", "show xlate count", "show access-list",
    "show nat detail", "show failover", "show vpn-sessiondb summary", "show crypto ipsec sa", "show logging", "show cpu usage", "show memory",
    "packet-tracer input ", "terminal pager 0", "ping ",
  ],
  FortiGate: [
    "get system status", "get system performance status", "get system interface physical", "get router info routing-table all", "get system arp",
    "get system ha status", "show system interface", "show firewall policy", "show firewall address", "show router static", "diagnose sys top 1 15 1",
    "diagnose sys session stat", "diagnose hardware deviceinfo nic ", "diagnose sniffer packet any '' 4", "diagnose debug flow filter addr ",
    "execute ping ", "execute traceroute ", "get vpn ipsec tunnel summary", "config system interface", "edit ", "set ", "next", "end",
  ],
  Aruba: [
    "show running-config", "show version", "show system", "show interface brief", "show interface ", "show vlan", "show lldp neighbor-info",
    "show mac-address-table", "show ip route", "show arp", "show logging -r", "show environment", "show lacp aggregates", "show spanning-tree",
    "show ap database", "show user-table", "ping ", "traceroute ",
  ],
  Juniper: [
    "show configuration", "show configuration | display set", "show version", "show interfaces terse", "show interfaces ", "show route",
    "show arp no-resolve", "show lldp neighbors", "show chassis hardware", "show chassis alarms", "show system uptime", "show system alarms",
    "show log messages | last 50", "show ospf neighbor", "show bgp summary", "show ethernet-switching table", "show | compare", "commit check",
    "set cli screen-length 0", "ping ", "traceroute ",
  ],
  Huawei: [
    "display current-configuration", "display saved-configuration", "display version", "display interface brief", "display ip interface brief",
    "display vlan", "display mac-address", "display ip routing-table", "display arp", "display lldp neighbor brief", "display cpu-usage",
    "display memory-usage", "display device", "display alarm active", "display logbuffer", "display eth-trunk", "display stp brief",
    "screen-length 0 temporary", "ping ", "tracert ", "system-view", "interface ", "quit", "return",
  ],
};
