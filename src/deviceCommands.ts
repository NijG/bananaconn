// Read-only commands worth one click on each kind of device the resource
// monitor recognises (see devmon.rs). They are typed into the user's own
// terminal, so nothing here changes configuration.

export interface DeviceInfo {
  /** devmon.rs Kind id: "cisco-ios", "fortigate", "aix", … */
  kind: string;
  vendor: string;
  /** Model / software, e.g. "IOS-XE 17.06.04", "FortiGate-100F v7.2.5", "Red Hat Enterprise Linux release 9.2". */
  label: string;
  /** Hostname from the prompt or `hostname`. */
  name: string;
  network: boolean;
  /** The running configuration can be backed up. */
  backup: boolean;
}

type Command = [label: string, command: string];

const CISCO_IOS: Command[] = [
  ["버전·가동 시간", "show version"],
  ["인터페이스 IP 요약", "show ip interface brief"],
  ["포트 상태", "show interfaces status"],
  ["VLAN", "show vlan brief"],
  ["이웃 장비 (CDP)", "show cdp neighbors"],
  ["이웃 장비 (LLDP)", "show lldp neighbors"],
  ["라우팅 테이블", "show ip route"],
  ["MAC 주소 테이블", "show mac address-table"],
  ["스패닝 트리 요약", "show spanning-tree summary"],
  ["로그", "show logging"],
  ["하드웨어 상태", "show environment all"],
  ["모듈·시리얼", "show inventory"],
];

const COMMANDS: Record<string, Command[]> = {
  "cisco-ios": CISCO_IOS,
  "cisco-iosxe": CISCO_IOS,
  "cisco-nxos": [
    ["버전·가동 시간", "show version"],
    ["인터페이스 요약", "show interface brief"],
    ["VLAN", "show vlan brief"],
    ["포트 채널", "show port-channel summary"],
    ["vPC 상태", "show vpc brief"],
    ["이웃 장비 (CDP)", "show cdp neighbors"],
    ["라우팅 테이블", "show ip route"],
    ["MAC 주소 테이블", "show mac address-table"],
    ["최근 로그 50줄", "show logging last 50"],
    ["하드웨어 상태", "show environment"],
  ],
  "cisco-asa": [
    ["버전·가동 시간", "show version"],
    ["인터페이스 IP", "show interface ip brief"],
    ["라우팅 테이블", "show route"],
    ["연결 수", "show conn count"],
    ["NAT 변환 수", "show xlate count"],
    ["이중화 상태", "show failover"],
    ["VPN 세션 요약", "show vpn-sessiondb summary"],
    ["CPU 사용률", "show cpu usage"],
    ["중요 로그 (레벨 1~3)", "show logging | include %ASA-[123]-"],
  ],
  fortigate: [
    ["시스템 상태", "get system status"],
    ["성능 (CPU·메모리·세션)", "get system performance status"],
    ["인터페이스 (물리)", "get system interface physical"],
    ["라우팅 테이블", "get router info routing-table all"],
    ["세션 통계", "diagnose sys session stat"],
    ["HA 상태", "get system ha status"],
    ["IPsec 터널 요약", "get vpn ipsec tunnel summary"],
    ["ARP 테이블", "get system arp"],
  ],
  "aruba-cx": [
    ["버전", "show version"],
    ["인터페이스 요약", "show interface brief"],
    ["VLAN", "show vlan"],
    ["이웃 장비 (LLDP)", "show lldp neighbor-info"],
    ["라우팅 테이블", "show ip route"],
    ["MAC 주소 테이블", "show mac-address-table"],
    ["VSX 상태", "show vsx status"],
    ["리소스 사용률", "show system resource-utilization"],
    ["최근 로그 50줄", "show logging -r -n 50"],
    ["팬·전원", "show environment fan"],
  ],
  "aruba-switch": [
    ["버전", "show version"],
    ["시스템 정보", "show system"],
    ["인터페이스 요약", "show interfaces brief"],
    ["VLAN", "show vlans"],
    ["이웃 장비 (LLDP)", "show lldp info remote-device"],
    ["라우팅 테이블", "show ip route"],
    ["MAC 주소 테이블", "show mac-address"],
    ["PoE 요약", "show power-over-ethernet brief"],
    ["로그 (최신순)", "show logging -r"],
  ],
  "aruba-controller": [
    ["버전", "show version"],
    ["AP 목록", "show ap database"],
    ["동작 중인 AP", "show ap active"],
    ["접속 사용자", "show user-table"],
    ["컨트롤러 목록", "show switches"],
    ["CPU 부하", "show cpuload"],
    ["메모리", "show memory"],
    ["오류 로그", "show log errorlog 50"],
  ],
  linux: [
    ["가동 시간·부하", "uptime"],
    ["OS 버전", "cat /etc/redhat-release 2>/dev/null || cat /etc/os-release"],
    ["디스크 사용량", "df -h"],
    ["메모리", "free -m"],
    ["디스크 장치", "lsblk"],
    ["IP 주소", "ip -br addr"],
    ["라우팅", "ip route"],
    ["실패한 서비스", "systemctl --failed"],
    ["최근 오류 로그 50줄", "journalctl -p err -n 50 --no-pager"],
    ["열린 포트", "ss -tlnp"],
    ["CPU 상위 프로세스", "top -b -n 1 | head -20"],
    ["최근 로그인", "last -n 10"],
  ],
  aix: [
    ["가동 시간·부하", "uptime"],
    ["OS 레벨", "oslevel -s"],
    ["파일 시스템 (GB)", "df -g"],
    ["페이징 공간", "lsps -a"],
    ["물리 볼륨", "lspv"],
    ["활성 볼륨 그룹", "lsvg -o"],
    ["디스크 장치", "lsdev -Cc disk"],
    ["오류 로그 (최근)", "errpt | head -20"],
    ["vmstat 5초", "vmstat 1 5"],
    ["라우팅", "netstat -rn"],
    ["마지막 부팅", "who -b"],
  ],
  hpux: [
    ["가동 시간·부하", "uptime"],
    ["하드웨어·메모리", "/usr/contrib/bin/machinfo"],
    ["파일 시스템", "bdf"],
    ["스왑", "swapinfo -tam"],
    ["디스크 장치", "ioscan -fnC disk"],
    ["볼륨 그룹", "vgdisplay"],
    ["syslog 최근 50줄", "tail -50 /var/adm/syslog/syslog.log"],
    ["클러스터 (Serviceguard)", "cmviewcl"],
    ["라우팅", "netstat -rn"],
    ["마지막 부팅", "who -b"],
  ],
  solaris: [
    ["OS 버전", "cat /etc/release"],
    ["가동 시간·부하", "uptime"],
    ["파일 시스템", "df -h"],
    ["CPU·메모리 추이 (5초)", "vmstat 1 5"],
    ["CPU 상위 프로세스", "prstat -s cpu -n 15 1 1"],
    ["스왑 사용량", "swap -s"],
    ["ZFS 풀 상태", "zpool status -x"],
    ["문제 있는 서비스", "svcs -xv"],
    ["라우팅", "netstat -rn"],
    ["마지막 부팅", "who -b"],
  ],
  "juniper-junos": [
    ["버전", "show version"],
    ["인터페이스 요약", "show interfaces terse"],
    ["라우팅 테이블", "show route summary"],
    ["장비 알람", "show chassis alarms"],
    ["하드웨어", "show chassis hardware"],
    ["CPU 사용률", "show chassis routing-engine"],
    ["하드웨어 상태", "show chassis environment"],
    ["가동 시간", "show system uptime"],
    ["저장소 사용량", "show system storage"],
    ["로그 최근 50줄", "show log messages | last 50"],
  ],
  "huawei-vrp": [
    ["버전", "display version"],
    ["인터페이스 IP 요약", "display ip interface brief"],
    ["인터페이스 요약", "display interface brief"],
    ["라우팅 테이블", "display ip routing-table"],
    ["CPU 사용률", "display cpu-usage"],
    ["메모리", "display memory-usage"],
    ["ARP 테이블", "display arp"],
    ["이웃 장비 (LLDP)", "display lldp neighbor brief"],
    ["로그", "display logbuffer"],
  ],
};

export function deviceCommands(kind: string): Command[] {
  return COMMANDS[kind] ?? [];
}

/** "Cisco IOS-XE 17.06.04", "Fortinet FortiGate-100F v7.2.5", "IBM AIX 3" … */
export function deviceTitle(d: DeviceInfo): string {
  if (d.kind === "linux") return d.label || "Linux";
  return d.label.toLowerCase().startsWith(d.vendor.toLowerCase()) ? d.label : `${d.vendor} ${d.label}`;
}
