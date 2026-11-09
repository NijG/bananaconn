// Built-in command snippets per operating system, added once to the user's
// snippet list (store.ts) where they can be edited or deleted like any other.
// Read-only checks only: nothing here changes a system or a device.

import type { Snippet } from "./store";

type Entry = [id: string, name: string, text: string];

const GROUPS: [group: string, entries: Entry[]][] = [
  [
    "Linux",
    [
      ["s-disk", "디스크 사용량", "df -h"],
      ["s-mem", "메모리 사용량", "free -h"],
      ["s-top", "CPU 상위 프로세스", "ps aux --sort=-%cpu | head -15"],
      ["lin-topmem", "메모리 상위 프로세스", "ps aux --sort=-%mem | head -15"],
      ["lin-uptime", "가동 시간·부하", "uptime"],
      ["lin-os", "OS 버전", "cat /etc/os-release"],
      ["lin-kernel", "커널 버전", "uname -a"],
      ["lin-vmstat", "CPU·메모리 추이 (5초)", "vmstat 1 5"],
      ["lin-inode", "inode 사용량", "df -i"],
      ["lin-du", "현재 폴더 큰 항목", "du -sh * 2>/dev/null | sort -rh | head -15"],
      ["lin-ip", "IP 주소", "ip -br addr"],
      ["lin-route", "라우팅 테이블", "ip route"],
      ["lin-ports", "열린 포트", "ss -tulpn"],
      ["lin-dns", "DNS 설정", "cat /etc/resolv.conf"],
      ["lin-failed", "실패한 서비스", "systemctl --failed"],
      ["lin-journal", "시스템 로그 최근 50줄", "journalctl -n 50 --no-pager"],
      ["lin-dmesg", "커널 메시지 최근 30줄", "dmesg | tail -30"],
      ["lin-last", "최근 로그인", "last -n 20"],
      ["lin-time", "시간·동기화", "timedatectl"],
    ],
  ],
  [
    "AIX",
    [
      ["aix-level", "OS 레벨", "oslevel -s"],
      ["aix-df", "파일 시스템 (GB)", "df -g"],
      ["aix-vmstat", "CPU·메모리 추이 (5초)", "vmstat 1 5"],
      ["aix-svmon", "메모리 요약", "svmon -G"],
      ["aix-paging", "페이징 공간", "lsps -a"],
      ["aix-topcpu", "CPU 상위 프로세스", "ps aux | sort -rn -k 3 | head -15"],
      ["aix-lsvg", "활성 볼륨 그룹", "lsvg -o"],
      ["aix-lspv", "물리 볼륨", "lspv"],
      ["aix-errpt", "오류 로그 최근 20건", "errpt | head -20"],
      ["aix-prtconf", "시스템 구성", "prtconf | head -40"],
      ["aix-ifconfig", "네트워크 주소", "ifconfig -a"],
      ["aix-route", "라우팅 테이블", "netstat -rn"],
      ["aix-listen", "대기 중인 포트", "netstat -an | grep LISTEN"],
    ],
  ],
  [
    "HP-UX",
    [
      ["hp-uname", "OS 버전", "uname -a"],
      ["hp-bdf", "파일 시스템", "bdf"],
      ["hp-vmstat", "CPU·메모리 추이 (5초)", "vmstat 1 5"],
      ["hp-swap", "스왑 사용량", "swapinfo -tam"],
      ["hp-topcpu", "CPU 상위 프로세스", "UNIX95= ps -ef -o pcpu,pid,user,args | sort -rn | head -15"],
      ["hp-machinfo", "하드웨어 정보", "machinfo"],
      ["hp-disks", "디스크 목록", "ioscan -fnC disk"],
      ["hp-vg", "볼륨 그룹", "vgdisplay"],
      ["hp-syslog", "시스템 로그 최근 50줄", "tail -50 /var/adm/syslog/syslog.log"],
      ["hp-netif", "네트워크 인터페이스", "netstat -in"],
      ["hp-route", "라우팅 테이블", "netstat -rn"],
    ],
  ],
  [
    "Solaris",
    [
      ["sol-release", "OS 버전", "cat /etc/release"],
      ["sol-df", "파일 시스템", "df -h"],
      ["sol-vmstat", "CPU·메모리 추이 (5초)", "vmstat 1 5"],
      ["sol-prstat", "CPU 상위 프로세스", "prstat -s cpu -n 15 1 1"],
      ["sol-swap", "스왑 사용량", "swap -s"],
      ["sol-zpool", "ZFS 풀 상태", "zpool status -x"],
      ["sol-svcs", "문제 있는 서비스", "svcs -xv"],
      ["sol-ifconfig", "네트워크 주소", "ifconfig -a"],
    ],
  ],
  [
    "Windows",
    [
      ["win-sysinfo", "시스템 정보", "systeminfo"],
      ["win-ip", "IP 설정", "ipconfig /all"],
      ["win-ports", "열린 포트·연결", "netstat -ano"],
      ["win-tasks", "실행 중인 프로세스", "tasklist"],
      ["win-topcpu", "CPU 상위 프로세스", "powershell -NoProfile -Command \"Get-Process | Sort-Object CPU -Descending | Select-Object -First 15 Name,Id,CPU,WS\""],
      ["win-mem", "메모리 사용량", "powershell -NoProfile -Command \"Get-CimInstance Win32_OperatingSystem | Select-Object @{N='FreeGB';E={[math]::Round($_.FreePhysicalMemory/1MB,1)}},@{N='TotalGB';E={[math]::Round($_.TotalVisibleMemorySize/1MB,1)}}\""],
      ["win-uptime", "가동 시간", "powershell -NoProfile -Command \"(Get-Date) - (Get-CimInstance Win32_OperatingSystem).LastBootUpTime\""],
      ["win-route", "라우팅 테이블", "route print"],
      ["win-disk", "디스크 여유 공간 (PowerShell)", "powershell -NoProfile -Command \"Get-PSDrive -PSProvider FileSystem\""],
      ["win-services", "실행 중인 서비스 (PowerShell)", "powershell -NoProfile -Command \"Get-Service | Where-Object Status -eq Running\""],
      ["win-events", "시스템 오류 이벤트 20건 (PowerShell)", "powershell -NoProfile -Command \"Get-WinEvent -FilterHashtable @{LogName='System';Level=2} -MaxEvents 20\""],
      ["win-whoami", "현재 사용자", "whoami"],
    ],
  ],
  [
    "Cisco IOS",
    [
      ["ios-termlen", "페이지 나눔 끄기", "terminal length 0"],
      ["ios-version", "버전·가동 시간", "show version"],
      ["ios-ipbrief", "인터페이스 IP 요약", "show ip interface brief"],
      ["ios-status", "포트 상태", "show interfaces status"],
      ["ios-vlan", "VLAN", "show vlan brief"],
      ["ios-cdp", "이웃 장비 (CDP)", "show cdp neighbors"],
      ["ios-route", "라우팅 테이블", "show ip route"],
      ["ios-mac", "MAC 주소 테이블", "show mac address-table"],
      ["ios-stp", "스패닝 트리 요약", "show spanning-tree summary"],
      ["ios-log", "로그", "show logging"],
      ["ios-cpu", "CPU 사용률", "show processes cpu sorted | exclude 0.00"],
      ["ios-run", "실행 중인 설정", "show running-config"],
      ["ios-env", "하드웨어 상태", "show environment all"],
    ],
  ],
  [
    "Cisco NX-OS",
    [
      ["nx-termlen", "페이지 나눔 끄기", "terminal length 0"],
      ["nx-version", "버전·가동 시간", "show version"],
      ["nx-intbrief", "인터페이스 요약", "show interface brief"],
      ["nx-vpc", "vPC 상태", "show vpc brief"],
      ["nx-pc", "포트 채널", "show port-channel summary"],
      ["nx-route", "라우팅 테이블", "show ip route"],
      ["nx-log", "최근 로그 50줄", "show logging last 50"],
      ["nx-env", "하드웨어 상태", "show environment"],
    ],
  ],
  [
    "Cisco ASA",
    [
      ["asa-pager", "페이지 나눔 끄기", "terminal pager 0"],
      ["asa-version", "버전", "show version"],
      ["asa-ipbrief", "인터페이스 IP 요약", "show interface ip brief"],
      ["asa-conn", "연결 수", "show conn count"],
      ["asa-xlate", "NAT 변환 수", "show xlate count"],
      ["asa-failover", "이중화 상태", "show failover"],
      ["asa-vpn", "VPN 세션 요약", "show vpn-sessiondb summary"],
      ["asa-cpu", "CPU 사용률", "show cpu usage"],
      ["asa-route", "라우팅 테이블", "show route"],
    ],
  ],
  [
    "FortiGate",
    [
      ["fg-status", "시스템 상태", "get system status"],
      ["fg-perf", "성능 (CPU·메모리·세션)", "get system performance status"],
      ["fg-ha", "HA 상태", "get system ha status"],
      ["fg-int", "인터페이스", "get system interface physical"],
      ["fg-route", "라우팅 테이블", "get router info routing-table all"],
      ["fg-session", "세션 통계", "get system session status"],
      ["fg-ipsec", "IPsec 터널 요약", "get vpn ipsec tunnel summary"],
      ["fg-arp", "ARP 테이블", "get system arp"],
    ],
  ],
  [
    "Aruba",
    [
      ["aru-version", "버전", "show version"],
      ["aru-system", "시스템 정보", "show system"],
      ["aru-intbrief", "인터페이스 요약", "show interface brief"],
      ["aru-vlans", "VLAN", "show vlans"],
      ["aru-lldp", "이웃 장비 (LLDP)", "show lldp neighbor-info"],
      ["aru-log", "로그 (최신순)", "show logging -r"],
      ["aru-run", "실행 중인 설정", "show running-config"],
    ],
  ],
  [
    "Juniper",
    [
      ["jun-version", "버전", "show version"],
      ["jun-terse", "인터페이스 요약", "show interfaces terse"],
      ["jun-route", "라우팅 테이블", "show route"],
      ["jun-alarms", "장비 알람", "show chassis alarms"],
      ["jun-hw", "하드웨어", "show chassis hardware"],
      ["jun-log", "로그 최근 50줄", "show log messages | last 50"],
      ["jun-config", "설정 (set 형식)", "show configuration | display set | no-more"],
    ],
  ],
  [
    "Huawei",
    [
      ["hw-nomore", "페이지 나눔 끄기", "screen-length 0 temporary"],
      ["hw-version", "버전", "display version"],
      ["hw-ipbrief", "인터페이스 IP 요약", "display ip interface brief"],
      ["hw-intbrief", "인터페이스 요약", "display interface brief"],
      ["hw-route", "라우팅 테이블", "display ip routing-table"],
      ["hw-cpu", "CPU 사용률", "display cpu-usage"],
      ["hw-log", "로그", "display logbuffer"],
      ["hw-config", "실행 중인 설정", "display current-configuration"],
    ],
  ],
  // Telephone systems (PBX). Avaya Communication Manager: SAT commands, and
  // two for the server's Linux shell.
  [
    "Avaya CM",
    [
      ["avc-ipsta", "등록된 IP 전화기", "list registered-ip-stations"],
      ["avc-station", "내선 목록", "list station"],
      ["avc-trunk", "트렁크 그룹 목록", "list trunk-group"],
      ["avc-mg", "미디어 게이트웨이", "list media-gateway"],
      ["avc-health", "시스템 상태", "status health"],
      ["avc-alarms", "알람", "display alarms"],
      ["avc-errors", "오류 기록", "display errors"],
      ["avc-options", "라이선스 기능", "display system-parameters customer-options"],
      ["avc-swver", "소프트웨어 버전 (서버 셸)", "swversion"],
      ["avc-statapp", "애플리케이션 상태 (서버 셸)", "statapp"],
    ],
  ],
  [
    "Cisco CUCM",
    [
      ["cucm-ver", "버전", "show version active"],
      ["cucm-status", "시스템 상태", "show status"],
      ["cucm-svc", "서비스 상태", "utils service list"],
      ["cucm-dbrep", "DB 복제 상태", "utils dbreplication runtimestate"],
      ["cucm-ntp", "NTP 상태", "utils ntp status"],
      ["cucm-net", "네트워크 설정", "show network eth0"],
      ["cucm-hw", "하드웨어", "show hardware"],
    ],
  ],
  [
    "Cisco CME·CUBE",
    [
      ["cme-nomore", "페이지 나눔 끄기", "terminal length 0"],
      ["cme-ephone", "등록된 SCCP 전화기", "show ephone registered"],
      ["cme-sipreg", "SIP 전화기 등록 정보", "show voice register all"],
      ["cme-registrar", "SIP 등록 서버 상태", "show sip-ua status registrar"],
      ["cme-ports", "음성 포트 요약", "show voice port summary"],
      ["cme-dialpeer", "다이얼 피어 요약", "show dial-peer voice summary"],
      ["cme-calls", "현재 음성 통화", "show call active voice brief"],
      ["cme-sipcalls", "SIP 통화 (CUBE)", "show sip-ua calls"],
      ["cme-dsp", "DSP 상태", "show voice dsp group all"],
    ],
  ],
  [
    "Asterisk·FreePBX",
    [
      ["ast-ver", "버전", 'asterisk -rx "core show version"'],
      ["ast-uptime", "가동 시간", 'asterisk -rx "core show uptime"'],
      ["ast-pjep", "PJSIP 엔드포인트 (내선)", 'asterisk -rx "pjsip show endpoints"'],
      ["ast-pjreg", "PJSIP 트렁크 등록", 'asterisk -rx "pjsip show registrations"'],
      ["ast-sippeers", "SIP 피어 (chan_sip)", 'asterisk -rx "sip show peers"'],
      ["ast-chan", "현재 통화 채널", 'asterisk -rx "core show channels"'],
      ["ast-modules", "FreePBX 모듈 목록", "fwconsole ma list"],
      ["ast-log", "Asterisk 로그 최근 50줄", "tail -n 50 /var/log/asterisk/full"],
    ],
  ],
];

/** Every built-in snippet, grouped by operating system. */
export const SNIPPET_LIBRARY: Snippet[] = GROUPS.flatMap(([group, entries]) =>
  entries.map(([id, name, text]) => ({ id, name, text, run: true, group })),
);

/** Snippet group shown first for a device kind the resource monitor recognised (devmon.rs). */
export function groupForKind(kind: string | undefined): string | undefined {
  if (!kind) return undefined;
  if (kind === "linux") return "Linux";
  if (kind === "aix") return "AIX";
  if (kind === "hpux") return "HP-UX";
  if (kind === "solaris") return "Solaris";
  if (kind === "windows") return "Windows";
  if (kind === "cisco-ios" || kind === "cisco-iosxe") return "Cisco IOS";
  if (kind === "cisco-nxos") return "Cisco NX-OS";
  if (kind === "cisco-asa") return "Cisco ASA";
  if (kind === "fortigate") return "FortiGate";
  if (kind.startsWith("aruba")) return "Aruba";
  if (kind.startsWith("juniper")) return "Juniper";
  if (kind.startsWith("huawei")) return "Huawei";
  return undefined;
}

/** The ids version 1 of the library offered (0.7.29 and before), for a list
 * seeded by it with no record of what it was offered (store.ts): those were
 * offered already, while later ones were not. */
export const SNIPPET_LIBRARY_V1_IDS = "s-disk s-mem s-top lin-topmem lin-uptime lin-os lin-kernel lin-vmstat lin-inode lin-du lin-ip lin-route lin-ports lin-dns lin-failed lin-journal lin-dmesg lin-last lin-time aix-level aix-df aix-vmstat aix-svmon aix-paging aix-topcpu aix-lsvg aix-lspv aix-errpt aix-prtconf aix-ifconfig aix-route aix-listen hp-uname hp-bdf hp-vmstat hp-swap hp-topcpu hp-machinfo hp-disks hp-vg hp-syslog hp-netif hp-route sol-release sol-df sol-vmstat sol-prstat sol-swap sol-zpool sol-svcs sol-ifconfig win-sysinfo win-ip win-ports win-tasks win-route win-disk win-services win-events win-whoami ios-termlen ios-version ios-ipbrief ios-status ios-vlan ios-cdp ios-route ios-mac ios-stp ios-log ios-cpu ios-run ios-env nx-termlen nx-version nx-intbrief nx-vpc nx-pc nx-route nx-log nx-env asa-pager asa-version asa-ipbrief asa-conn asa-xlate asa-failover asa-vpn asa-cpu asa-route fg-status fg-perf fg-ha fg-int fg-route fg-session fg-ipsec fg-arp aru-version aru-system aru-intbrief aru-vlans aru-lldp aru-log aru-run jun-version jun-terse jun-route jun-alarms jun-hw jun-log jun-config hw-nomore hw-version hw-ipbrief hw-intbrief hw-route hw-cpu hw-log hw-config".split(" ");

/** Version of the library above; raise it when entries are added (store.ts adds the new ones once). */
export const SNIPPET_LIBRARY_VERSION = 3;
