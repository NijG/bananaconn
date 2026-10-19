// Lucide icons rendered as inline SVG strings. Only the icons the app uses are
// imported, so the bundle does not carry the whole icon set.

import {
  AppWindow,
  ArrowUp,
  Cable,
  Check,
  ChevronDown,
  CircleHelp,
  ClipboardPaste,
  ClipboardType,
  ChevronRight,
  Columns2,
  Copy,
  CopyPlus,
  CornerDownLeft,
  createElement,
  Download,
  Eraser,
  ExternalLink,
  Eye,
  File,
  Activity,
  Circle,
  CircleStop,
  FileText,
  Globe,
  Highlighter,
  LockKeyhole,
  Network,
  PanelRight,
  Unplug,
  Usb,
  Zap,
  Waypoints,
  WrapText,
  Folder,
  FolderKey,
  FolderLock,
  FolderOpen,
  FolderPlus,
  FolderSync,
  HardDrive,
  House,
  Info,
  Key,
  Keyboard,
  KeyRound,
  LayoutGrid,
  Lock,
  Maximize2,
  Minus,
  Monitor,
  PanelLeft,
  Pencil,
  Play,
  Plus,
  Radio,
  RefreshCw,
  RotateCw,
  Rows2,
  Save,
  ScreenShare,
  ScrollText,
  Search,
  Server,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Square,
  SquareTerminal,
  Trash2,
  TriangleAlert,
  Unlink,
  Upload,
  WifiOff,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide";

type IconNode = Parameters<typeof createElement>[0];

const ICONS: Record<string, IconNode> = {
  CircleHelp,
  ClipboardPaste,
  CopyPlus,
  AppWindow, ArrowUp, Cable, Check, ChevronDown, ChevronRight, ClipboardType, Columns2, Copy, CornerDownLeft, Download,
  Eraser, ExternalLink, Eye, File, Folder, FolderKey, FolderLock, FolderOpen, FolderPlus, FolderSync, HardDrive, House, Info, Key, Keyboard, KeyRound,
  LayoutGrid, Lock, Maximize2, Minus, Monitor, PanelLeft, Pencil, Play, Plus, Radio, RefreshCw, RotateCw, Rows2, Save,
  ScreenShare, ScrollText, Search, Server, Settings, ShieldAlert, ShieldCheck, Sparkles, Square, SquareTerminal,
  Trash2, TriangleAlert, Unlink, Upload, WifiOff, X, ZoomIn, ZoomOut,
  Activity, Circle, CircleStop, FileText, Globe, Highlighter, LockKeyhole, Network, PanelRight, Unplug, Usb, Waypoints, WrapText, Zap,
};

const cache = new Map<string, string>();

export function icon(name: string, size = 16, cls = ""): string {
  const key = `${name}:${size}:${cls}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const node = ICONS[name];
  if (!node) {
    console.warn(`[icons] unknown icon: ${name}`);
    return "";
  }
  const svg = createElement(node, {
    width: size,
    height: size,
    "stroke-width": 1.75,
    class: `ico ${cls}`.trim(),
  });
  const html = svg.outerHTML;
  cache.set(key, html);
  return html;
}

