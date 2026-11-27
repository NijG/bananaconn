// An SNMP object identifier selected in a terminal (snmpwalk -On output, a
// trap in a log, a monitoring tool's config) by the name net-snmp prints for
// it ("1.3.6.1.2.1.31.1.1.1.6.10001" → "IF-MIB::ifHCInOctets.10001"): the
// standard objects a device's interfaces and identity are read by, as the
// MIBs define them (SNMPv2-MIB, RFC 3418: the system group; IF-MIB, RFC 2863:
// ifTable and ifXTable; IP-MIB's ipAddrTable; HOST-RESOURCES-MIB, RFC 2790:
// hrSystem, hrStorageTable, hrProcessorTable; ENTITY-MIB, RFC 4133:
// entPhysicalTable), and an enterprise's subtree by its number. Nothing
// outside these is named. No imports: scripts/numbers-check.mjs runs it.

/** mib-2 (1.3.6.1.2.1). */
const MIB2 = "1.3.6.1.2.1";

/** Tables of columns: the OID of the entry and the names of its columns 1…n. */
const TABLES: [entry: string, module: string, columns: string[]][] = [
  // SNMPv2-MIB system group (scalars: ".0" follows).
  [`${MIB2}.1`, "SNMPv2-MIB", ["sysDescr", "sysObjectID", "sysUpTime", "sysContact", "sysName", "sysLocation", "sysServices"]],
  // IF-MIB ifTable's ifEntry.
  [
    `${MIB2}.2.2.1`,
    "IF-MIB",
    ["ifIndex", "ifDescr", "ifType", "ifMtu", "ifSpeed", "ifPhysAddress", "ifAdminStatus", "ifOperStatus", "ifLastChange", "ifInOctets", "ifInUcastPkts", "ifInNUcastPkts", "ifInDiscards", "ifInErrors", "ifInUnknownProtos", "ifOutOctets", "ifOutUcastPkts", "ifOutNUcastPkts", "ifOutDiscards", "ifOutErrors", "ifOutQLen", "ifSpecific"],
  ],
  // IF-MIB ifXTable's ifXEntry.
  [
    `${MIB2}.31.1.1.1`,
    "IF-MIB",
    ["ifName", "ifInMulticastPkts", "ifInBroadcastPkts", "ifOutMulticastPkts", "ifOutBroadcastPkts", "ifHCInOctets", "ifHCInUcastPkts", "ifHCInMulticastPkts", "ifHCInBroadcastPkts", "ifHCOutOctets", "ifHCOutUcastPkts", "ifHCOutMulticastPkts", "ifHCOutBroadcastPkts", "ifLinkUpDownTrapEnable", "ifHighSpeed", "ifPromiscuousMode", "ifConnectorPresent", "ifAlias", "ifCounterDiscontinuityTime"],
  ],
  // UCD-SNMP-MIB laTable's laEntry (loaded by default in net-snmp): a Linux
  // snmpd's load averages; laErrorFlag and laErrMessage are columns 100, 101.
  [
    "1.3.6.1.4.1.2021.10.1",
    "UCD-SNMP-MIB",
    Object.assign(["laIndex", "laNames", "laLoad", "laConfig", "laLoadInt", "laLoadFloat"], { 99: "laErrorFlag", 100: "laErrMessage" }),
  ],
  // IP-MIB ipAddrTable's ipAddrEntry (RFC 1213, kept in RFC 4293).
  [`${MIB2}.4.20.1`, "IP-MIB", ["ipAdEntAddr", "ipAdEntIfIndex", "ipAdEntNetMask", "ipAdEntBcastAddr", "ipAdEntReasmMaxSize"]],
  // HOST-RESOURCES-MIB (RFC 2790): hrSystem's scalars, hrStorageEntry, hrProcessorEntry.
  [`${MIB2}.25.1`, "HOST-RESOURCES-MIB", ["hrSystemUptime", "hrSystemDate", "hrSystemInitialLoadDevice", "hrSystemInitialLoadParameters", "hrSystemNumUsers", "hrSystemProcesses", "hrSystemMaxProcesses"]],
  [`${MIB2}.25.2.3.1`, "HOST-RESOURCES-MIB", ["hrStorageIndex", "hrStorageType", "hrStorageDescr", "hrStorageAllocationUnits", "hrStorageSize", "hrStorageUsed", "hrStorageAllocationFailures"]],
  [`${MIB2}.25.3.3.1`, "HOST-RESOURCES-MIB", ["hrProcessorFrwID", "hrProcessorLoad"]],
  // ENTITY-MIB entPhysicalEntry (RFC 2737; 4133 adds MfgDate and Uris): a chassis's modules, serials.
  [
    `${MIB2}.47.1.1.1.1`,
    "ENTITY-MIB",
    ["entPhysicalIndex", "entPhysicalDescr", "entPhysicalVendorType", "entPhysicalContainedIn", "entPhysicalClass", "entPhysicalParentRelPos", "entPhysicalName", "entPhysicalHardwareRev", "entPhysicalFirmwareRev", "entPhysicalSoftwareRev", "entPhysicalSerialNum", "entPhysicalMfgName", "entPhysicalModelName", "entPhysicalAlias", "entPhysicalAssetID", "entPhysicalIsFRU", "entPhysicalMfgDate", "entPhysicalUris"],
  ],
];

/** Single objects by their whole OID (no index after them). */
const OBJECTS: Record<string, string> = {
  // net-snmp names sysUpTime's instance by DISMAN-EVENT-MIB (loaded by
  // default), as snmpwalk and snmptrapd print it.
  [`${MIB2}.1.3.0`]: "DISMAN-EVENT-MIB::sysUpTimeInstance",
  "1.3.6.1.4.1": "SNMPv2-SMI::enterprises",
  // net-snmp's own agent: the sysObjectID a Linux snmpd reports (NET-SNMP-MIB).
  "1.3.6.1.4.1.8072.3.2": "NET-SNMP-MIB::netSnmpAgentOIDs",
  [`${MIB2}.2.1`]: "IF-MIB::ifNumber",
  // SNMPv2-MIB snmpTrap: the trap's own identity in an SNMPv2 notification.
  "1.3.6.1.6.3.1.1.4.1": "SNMPv2-MIB::snmpTrapOID",
  // IF-MIB notifications (snmpTraps 3, 4).
  "1.3.6.1.6.3.1.1.5.3": "IF-MIB::linkDown",
  "1.3.6.1.6.3.1.1.5.4": "IF-MIB::linkUp",
  "1.3.6.1.6.3.1.1.5.1": "SNMPv2-MIB::coldStart",
  "1.3.6.1.6.3.1.1.5.2": "SNMPv2-MIB::warmStart",
  "1.3.6.1.6.3.1.1.5.5": "SNMPv2-MIB::authenticationFailure",
};

/** The name net-snmp prints for `selection` when it is a dotted OID under
 * one of the objects above ("SNMPv2-MIB::sysUpTime.0",
 * "IF-MIB::ifOperStatus.3", "SNMPv2-SMI::enterprises.9.9.46"), else null. */
export function oidName(selection: string): string | null {
  const m = /^\.?((?:0|[1-9]\d{0,9})(?:\.(?:0|[1-9]\d{0,9})){4,127})$/.exec(selection.trim());
  if (!m) return null;
  const oid = m[1];
  if (oid.split(".").some((n) => Number(n) > 4294967295)) return null;
  if (OBJECTS[oid]) return OBJECTS[oid];
  // As net-snmp names an OID: by the deepest node it knows that the OID is
  // under. A table's column ("IF-MIB::ifDescr.3": the entry and the column
  // matched), or an object with something after it (an instance, or a branch:
  // "DISMAN-EVENT-MIB::sysUpTimeInstance.5", "NET-SNMP-MIB::netSnmpAgentOIDs.10").
  let best: { depth: number; name: string } | null = null;
  for (const [entry, module, columns] of TABLES) {
    if (!oid.startsWith(`${entry}.`)) continue;
    const [column, ...index] = oid.slice(entry.length + 1).split(".");
    const name = columns[Number(column) - 1];
    // A column with no instance is the column itself ("IF-MIB::ifDescr");
    // one with no name here is left to the object it is under.
    if (name) best = { depth: entry.length + 1 + column.length, name: `${module}::${name}${index.length ? `.${index.join(".")}` : ""}` };
  }
  for (const whole of Object.keys(OBJECTS)) {
    if (!oid.startsWith(`${whole}.`) || (best && best.depth >= whole.length)) continue;
    best = { depth: whole.length, name: `${OBJECTS[whole]}${oid.slice(whole.length)}` };
  }
  return best?.name ?? null;
}
