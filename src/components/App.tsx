'use client';

import {useEffect, useMemo, useState} from 'react';
import {
  AlertCircle, ArrowRight, Bell, Boxes, Building2, ChevronDown, ClipboardCheck,
  ClipboardList, FileText, GitBranch, Home, Languages, Layers3, Menu,
  MoreHorizontal, PackageCheck, Search, ShieldAlert, Truck, Warehouse, X,
} from 'lucide-react';
import HomeDashboard from './HomeDashboard';
import TraceView from './TraceView';
import Reports from './Reports';
import {labels, navLabel, statuses, type NavKey} from '@/lib/i18n';
import demo from '@/data/demo.json';
import traceSamples from '@/data/traces.json';

type Row = Record<string, any>;
type Column = {key: string; label: string};
type Panel = {title: string; rows: Row[]; columns: Column[]};
const data: Row = demo;
const traces: Record<string, Row> = traceSamples;
const mainNav: NavKey[] = ['home', 'receipts', 'quality', 'orders', 'inventory', 'shipments', 'trace', 'holds', 'documents'];
const moreNav: NavKey[] = ['materials', 'suppliers', 'specs', 'lots', 'nonconformities', 'reports'];
const icons: Partial<Record<NavKey, typeof Home>> = {
  home: Home, receipts: Boxes, quality: ClipboardCheck, orders: ClipboardList,
  inventory: Warehouse, shipments: Truck, trace: GitBranch, holds: ShieldAlert,
  documents: FileText, materials: Layers3, suppliers: Building2, specs: ClipboardCheck,
  lots: PackageCheck, nonconformities: AlertCircle, reports: FileText,
};
const descriptions: Partial<Record<NavKey, string>> = {
  home: 'Партии, решения и движение на одном экране',
  receipts: 'Поступления и связанные партии сырья',
  quality: 'Примеры контроля и решений по качеству',
  orders: 'Производственные заказы и фактический расход',
  inventory: 'Партии и остатки по зонам хранения',
  shipments: 'Отгрузки и покупатели',
  trace: 'Происхождение и последствия дефекта',
  holds: 'Блокировки и отзыв партий',
  documents: 'Примеры документов и связанных записей',
};
const c = (key: string, label: string): Column => ({key, label});

function panelsFor(section: NavKey): Panel[] {
  switch (section) {
    case 'materials': return [{title: 'Номенклатура материалов', rows: data.materials, columns: [c('code', 'Код'), c('name', 'Материал'), c('category', 'Категория'), c('unit', 'Ед.')] }];
    case 'suppliers': return [{title: 'Поставщики', rows: data.suppliers, columns: [c('code', 'Код'), c('name', 'Название'), c('contact', 'Контакт')] }];
    case 'receipts': return [
      {title: 'Поступления', rows: data.receipts, columns: [c('code', 'Код'), c('supplier_name', 'Поставщик'), c('delivery_document', 'Документ'), c('status', 'Статус')]},
      {title: 'Партии сырья', rows: data.lots.filter((row: Row) => row.kind === 'material'), columns: [c('code', 'Партия'), c('material_name', 'Материал'), c('supplier_name', 'Поставщик'), c('quality_status', 'Качество')]},
    ];
    case 'quality': return [
      {title: 'Партии на контроле', rows: data.lots.filter((row: Row) => row.quality_status === 'quarantine'), columns: [c('code', 'Партия'), c('material_name', 'Материал'), c('product_name', 'Изделие'), c('quality_status', 'Статус')]},
      {title: 'Протоколы контроля', rows: data.checks, columns: [c('lot_code', 'Партия'), c('kind', 'Вид'), c('result_summary', 'Результат'), c('performed_at', 'Дата')]},
      {title: 'Решения', rows: data.decisions, columns: [c('lot_code', 'Партия'), c('decision', 'Решение'), c('basis', 'Основание'), c('created_at', 'Дата')]},
    ];
    case 'specs': return [{title: 'Спецификации', rows: data.specs, columns: [c('code', 'Код'), c('product_name', 'Изделие'), c('version_no', 'Версия'), c('status', 'Статус')]}];
    case 'orders': return [
      {title: 'Производственные заказы', rows: data.orders, columns: [c('code', 'Заказ'), c('product_name', 'Изделие'), c('planned_quantity', 'План'), c('status', 'Статус')]},
      {title: 'Производственные запуски', rows: data.runs, columns: [c('code', 'Запуск'), c('order_code', 'Заказ'), c('started_at', 'Начало'), c('status', 'Статус')]},
      {title: 'Фактический расход материала', rows: data.consumptions, columns: [c('lot_code', 'Партия сырья'), c('quantity', 'Количество'), c('unit_code', 'Ед.'), c('created_at', 'Дата')]},
    ];
    case 'lots': return [{title: 'Готовые партии', rows: data.lots.filter((row: Row) => row.kind === 'finished'), columns: [c('code', 'Партия'), c('product_name', 'Изделие'), c('quality_status', 'Качество'), c('expires_at', 'Годен до')]}];
    case 'inventory': return [
      {title: 'Остатки', rows: data.balances, columns: [c('lot_code', 'Партия'), c('warehouse_name', 'Зона'), c('quantity', 'Количество')]},
      {title: 'Склады и зоны', rows: data.warehouses, columns: [c('code', 'Код'), c('name', 'Название'), c('kind', 'Назначение')]},
    ];
    case 'shipments': return [
      {title: 'Отгрузки', rows: data.shipments, columns: [c('code', 'Отгрузка'), c('customer_name_snapshot', 'Покупатель'), c('confirmed_at', 'Дата'), c('status', 'Статус')]},
      {title: 'Распределение партий', rows: data.allocations, columns: [c('lot_code', 'Партия'), c('product_name', 'Изделие'), c('quantity', 'Количество')]},
      {title: 'Покупатели', rows: data.customers, columns: [c('code', 'Код'), c('name', 'Название'), c('address', 'Адрес')]},
    ];
    case 'nonconformities': return [{title: 'Несоответствия', rows: data.nonconformities, columns: [c('code', 'Код'), c('lot_code', 'Партия'), c('description', 'Описание'), c('status', 'Статус')]}];
    case 'holds': return [
      {title: 'Блокировки', rows: data.holds, columns: [c('lot_code', 'Партия'), c('reason', 'Причина'), c('placed_at', 'Дата'), c('released_at', 'Снята')]},
      {title: 'Кампании отзыва', rows: data.recalls, columns: [c('code', 'Код'), c('source_lot_code', 'Источник'), c('reason', 'Причина'), c('status', 'Статус')]},
      {title: 'Затронутые покупатели', rows: data.recallActions, columns: [c('customer_name_snapshot', 'Покупатель'), c('lot_code', 'Партия'), c('shipment_code', 'Отгрузка'), c('status', 'Статус')]},
    ];
    case 'documents': return [{title: 'Примеры документов', rows: data.documents, columns: [c('title', 'Название'), c('kind', 'Вид'), c('entity_type', 'Связь'), c('version_no', 'Версия')]}];
    default: return [];
  }
}

function displayValue(row: Row, key: string, lang: 'ru' | 'kk') {
  const value = row[key];
  if (value == null || value === '') return '—';
  if ((key === 'status' || key === 'quality_status') && statuses[String(value)]) {
    return <span className={`badge badge-${['released', 'shipped', 'completed', 'closed'].includes(String(value)) ? 'good' : 'warning'}`}><span className="badge-dot"/>{statuses[String(value)][lang]}</span>;
  }
  if (key.endsWith('_at') && !Number.isNaN(Date.parse(String(value)))) return new Intl.DateTimeFormat(lang === 'kk' ? 'kk-KZ' : 'ru-RU', {day: '2-digit', month: 'short', year: 'numeric'}).format(new Date(value));
  if (typeof value === 'object') return Array.isArray(value) ? value.join(', ') : 'Данные';
  return String(value);
}

function DataPanel({panel, filter, onSelect, lang}: {panel: Panel; filter: string; onSelect: (row: Row) => void; lang: 'ru' | 'kk'}) {
  const term = filter.trim().toLowerCase();
  const rows = panel.rows.filter(row => !term || Object.values(row).some(value => typeof value === 'string' && value.toLowerCase().includes(term)));
  return <section className="panel"><div className="panel-title"><h3>{panel.title}</h3><span className="panel-count">{rows.length} записей</span></div>{rows.length ? <div className="table-wrap"><table><thead><tr>{panel.columns.map(column => <th key={column.key}>{column.label}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={row.id || index} className="clickable" onClick={() => onSelect(row)}>{panel.columns.map(column => <td key={column.key}>{displayValue(row, column.key, lang)}</td>)}</tr>)}</tbody></table></div> : <div className="empty"><Boxes size={26}/><strong>По запросу ничего не найдено</strong><span>Попробуйте другой номер или название.</span></div>}</section>;
}

export default function App() {
  const [lang, setLang] = useState<'ru' | 'kk'>('ru');
  const [section, setSection] = useState<NavKey>('home');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [navMoreOpen, setNavMoreOpen] = useState(false);
  const [queryText, setQueryText] = useState('');
  const [globalSearch, setGlobalSearch] = useState('');
  const [traceQuery, setTraceQuery] = useState('');
  const [traceData, setTraceData] = useState<Row | null>(null);
  const [detail, setDetail] = useState<Row | null>(null);
  const t = labels[lang];
  const panels = useMemo(() => panelsFor(section), [section]);

  function navigate(next: NavKey, filter = '') {
    setSection(next); setQueryText(filter); setSidebarOpen(false); setDetail(null);
  }
  function searchTrace(query: string) {
    const search = query.trim().toLowerCase();
    let lot = data.lots.find((item: Row) => item.code.toLowerCase() === search || item.supplier_lot_number?.toLowerCase() === search);
    if (!lot) {
      const order = data.orders.find((item: Row) => item.code.toLowerCase() === search);
      const run = data.runs.find((item: Row) => item.code.toLowerCase() === search || item.order_id === order?.id);
      lot = data.lots.find((item: Row) => item.id === run?.finished_lot_id);
    }
    if (!lot) {
      const shipment = data.shipments.find((item: Row) => item.code.toLowerCase() === search);
      const allocation = data.allocations.find((item: Row) => item.shipment_id === shipment?.id);
      lot = data.lots.find((item: Row) => item.id === allocation?.lot_id);
    }
    setTraceQuery(query);
    setTraceData(lot ? traces[lot.code] : {notFound: true, query});
    setSection('trace'); setSidebarOpen(false);
  }
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('lot');
    if (code) searchTrace(code);
  }, []);

  return <div className="app-shell">
    <aside className={`sidebar ${sidebarOpen ? 'sidebar-open' : ''}`}>
      <div className="workspace-label">РАБОЧЕЕ ПРОСТРАНСТВО</div>
      <nav aria-label="Основная навигация">
        {mainNav.map(key => {const Icon = icons[key] || Boxes; const name = key === 'home' ? 'Главная' : key === 'receipts' ? 'Партии и материалы' : key === 'orders' ? 'Производство' : navLabel(lang, key); return <button key={key} className={`nav-item ${section === key ? 'active' : ''}`} onClick={() => navigate(key)}><Icon size={17}/><span>{name}</span></button>;})}
        <button className={`nav-item nav-more ${navMoreOpen ? 'expanded' : ''}`} onClick={() => setNavMoreOpen(!navMoreOpen)} aria-expanded={navMoreOpen}><MoreHorizontal size={17}/><span>Другие разделы</span><ChevronDown size={14}/></button>
        {navMoreOpen && moreNav.map(key => {const Icon = icons[key] || Boxes; return <button key={key} className={`nav-item nav-secondary ${section === key ? 'active' : ''}`} onClick={() => navigate(key)}><Icon size={17}/><span>{navLabel(lang, key)}</span></button>;})}
      </nav>
      <div className="sidebar-bottom"><div className="demo-tag">Демо-данные · вымышленное предприятие</div><div className="sidebar-user"><div className="avatar">Д</div><div><strong>Открытая демо-версия</strong><span>Просмотр без входа и сервера</span></div></div></div>
    </aside>
    <div className="mobile-overlay" hidden={!sidebarOpen} onClick={() => setSidebarOpen(false)}/>
    <main className="main"><header className="topbar"><div className="topbar-brand"><span className="topbar-logo"><i/><i/></span><strong>MedTrace</strong></div><button className="icon-button menu-button" onClick={() => setSidebarOpen(true)} aria-label="Открыть меню"><Menu size={21}/></button><form className="global-search" onSubmit={event => {event.preventDefault(); if (globalSearch.trim()) searchTrace(globalSearch);}}><input aria-label="Поиск партии" placeholder="Поиск партии" value={globalSearch} onChange={event => setGlobalSearch(event.target.value)}/><button type="submit" aria-label="Искать"><Search size={17}/></button></form><span className="topbar-date">{new Intl.DateTimeFormat(lang === 'kk' ? 'kk-KZ' : 'ru-RU', {day: 'numeric', month: 'long', year: 'numeric', weekday: 'long'}).format(new Date())}</span><div className="topbar-spacer"/><button className="topbar-icon" onClick={() => navigate('quality')} title="Контроль качества" aria-label="Контроль качества"><Bell size={17}/></button><span className="demo-mode-pill">ДЕМО · ТОЛЬКО ПРОСМОТР</span><button className="topbar-action language-action" onClick={() => setLang(lang === 'ru' ? 'kk' : 'ru')} title="Сменить язык"><Languages size={16}/>{lang.toUpperCase()}</button></header>
      <div className="content"><div className="page-head"><div>{section !== 'home' && <div className="eyebrow">MEDTRACE / {section.toUpperCase()}</div>}<h1>{section === 'home' ? 'Рабочий стол' : navLabel(lang, section)}</h1><p>{section === 'home' ? 'Партии и качество на одном экране' : descriptions[section] || 'Демонстрационный раздел MedTrace'}</p></div></div>
        {section !== 'home' && <div className="readonly-note"><AlertCircle size={15}/><span>Демонстрационная версия: данные вымышлены, изменения не сохраняются.</span></div>}
        {section === 'home' && <HomeDashboard data={data} onNavigate={navigate} onTrace={searchTrace}/>}
        {section === 'trace' && <TraceView value={traceQuery} onChange={setTraceQuery} onSearch={() => searchTrace(traceQuery)} loading={false} result={traceData} onLot={searchTrace}/>}
        {section === 'reports' && <Reports data={data}/>}
        {panels.length > 0 && <div className="stack"><div className="toolbar"><div className="search-box"><Search size={18}/><input placeholder={t.search} value={queryText} onChange={event => setQueryText(event.target.value)}/>{queryText && <button onClick={() => setQueryText('')} aria-label="Очистить"><X size={15}/></button>}</div></div>{panels.map(panel => <DataPanel key={panel.title} panel={panel} filter={queryText} onSelect={setDetail} lang={lang}/>)}</div>}
      </div>
    </main>
    {detail && <div className="drawer-backdrop" onMouseDown={event => {if (event.target === event.currentTarget) setDetail(null);}}><div className="drawer"><div className="drawer-head"><div><span className="eyebrow">ДЕМО · КАРТОЧКА ЗАПИСИ</span><h2>{detail.code || detail.title || detail.name || 'Детали'}</h2></div><button className="icon-button" onClick={() => setDetail(null)} aria-label="Закрыть"><X size={20}/></button></div><div className="drawer-body"><div className="detail-section"><h4>Поля записи</h4>{Object.entries(detail).filter(([key, value]) => !['id', 'version', 'created_by', 'actor_id'].includes(key) && value != null && typeof value !== 'object').map(([key, value]) => <div className="key-row" key={key}><span>{key.replaceAll('_', ' ')}</span><strong>{String(value)}</strong></div>)}</div>{detail.code && (detail.kind === 'material' || detail.kind === 'finished') && <button className="button button-secondary full" onClick={() => {setDetail(null); searchTrace(detail.code);}}><GitBranch size={16}/>Показать связи <ArrowRight size={15}/></button>}</div></div></div>}
  </div>;
}
