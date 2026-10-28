'use client';

import {ArrowRight, Bell, CalendarDays, Check, ClipboardCheck, FileText, GitBranch, PackageCheck, ShieldAlert} from 'lucide-react';
import type {NavKey} from '@/lib/i18n';

type Row = Record<string, any>;
type Snapshot = Record<string, any>;

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).map(part => part[0]).slice(0, 2).join('').toUpperCase();
}

function calendarCells(now: Date) {
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  const offset = (first.getDay() + 6) % 7;
  const count = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return [...Array(offset).fill(null), ...Array.from({length: count}, (_, index) => index + 1)];
}

export default function HomeDashboard({data, onNavigate, onTrace}: {
  data: Snapshot;
  onNavigate: (section: NavKey, filter?: string) => void;
  onTrace: (code: string) => void;
}) {
  const actor = data.actor || {name: 'Айгүл'};
  const canSeeShipments = true;
  const now = new Date();
  const materialLots: Row[] = (data.lots || []).filter((lot: Row) => lot.kind === 'material');
  const finishedLots: Row[] = (data.lots || []).filter((lot: Row) => lot.kind === 'finished');
  const source = materialLots.find(lot => lot.code === 'RM-2026-000001') ||
    materialLots.find(lot => (data.consumptions || []).some((c: Row) => c.lot_id === lot.id)) || materialLots[0];
  const runIds = new Set((data.consumptions || []).filter((c: Row) => c.lot_id === source?.id).map((c: Row) => c.run_id));
  const producedIds = new Set((data.runs || []).filter((run: Row) => runIds.has(run.id)).map((run: Row) => run.finished_lot_id));
  const relatedFinished = finishedLots.filter(lot => producedIds.has(lot.id)).slice(0, 3);
  const finishedIds = new Set(relatedFinished.map(lot => lot.id));
  const allocations: Row[] = (data.allocations || []).filter((allocation: Row) => finishedIds.has(allocation.lot_id));
  const recipients = Array.from(new Set(allocations.map(allocation =>
    (data.shipments || []).find((shipment: Row) => shipment.id === allocation.shipment_id)?.current_customer_name
  ).filter(Boolean))) as string[];
  const activeHolds: Row[] = (data.holds || []).filter((hold: Row) => !hold.released_at);

  const tasks: {title: string; detail: string; section: NavKey; filter?: string; tone: string}[] = [];
  const qualityLot = (data.lots || []).find((lot: Row) => lot.quality_status === 'quarantine');
  if (qualityLot) tasks.push({title: 'Проверить партию на контроле', detail: `${qualityLot.code} · ${qualityLot.material_name || qualityLot.product_name || 'Партия'}`, section: 'quality', filter: qualityLot.code, tone: 'teal'});
  if (activeHolds[0]) tasks.push({title: 'Оценить влияние блокировки', detail: activeHolds[0].lot_code || 'Активная блокировка', section: 'holds', tone: 'amber'});
  const activeOrder = (data.orders || []).find((order: Row) => ['planned', 'reserved', 'in_progress'].includes(order.status));
  if (activeOrder) tasks.push({title: 'Проверить производственный заказ', detail: `${activeOrder.code} · ${activeOrder.product_name}`, section: 'orders', filter: activeOrder.code, tone: 'blue'});
  if (tasks.length < 3 && data.documents?.length) tasks.push({title: 'Просмотреть документы', detail: 'Протоколы и связанные записи', section: 'documents', tone: 'slate'});

  const month = new Intl.DateTimeFormat('ru-RU', {month: 'long', year: 'numeric'}).format(now);
  const today = new Intl.DateTimeFormat('ru-RU', {day: 'numeric', month: 'long'}).format(now);
  const roles = 'Демо-профиль';

  return <div className="home-composition">
    <div className="home-top-grid">
      <section className="welcome-card">
        <div className="welcome-copy">
          <span className="home-kicker">МЕДИЦИНСКОЕ ПРОИЗВОДСТВО</span>
          <h2>Здравствуйте, {actor.name.split(' ')[0]}</h2>
          <p>Демонстрационный пример показывает путь партии от приёмки сырья до покупателя.</p>
          <button className="quiet-link" onClick={() => onNavigate('lots')}>Открыть журнал партий <ArrowRight size={15}/></button>
        </div>
        <div className="welcome-illustration" aria-hidden="true">
          <span className="illustration-orbit"/><span className="illustration-dot dot-one"/><span className="illustration-dot dot-two"/>
          <span className="illustration-check"><Check size={18}/></span>
          <span className="illustration-folder"><span className="folder-cross">+</span></span>
          <span className="illustration-record"><span/><span/><span className="record-cross">+</span></span>
        </div>
      </section>
      <section className="calendar-card">
        <div className="calendar-pane">
          <div className="card-heading"><h3>{month}</h3><CalendarDays size={16}/></div>
          <div className="calendar-weekdays">{['ПН','ВТ','СР','ЧТ','ПТ','СБ','ВС'].map(day => <span key={day}>{day}</span>)}</div>
          <div className="calendar-days">{calendarCells(now).map((day, index) => <span key={index} className={day === now.getDate() ? 'today' : day ? '' : 'blank'}>{day || ''}</span>)}</div>
        </div>
        <div className="today-pane">
          <div className="card-heading"><h3>Сейчас в работе</h3><span>{today}</span></div>
          {tasks.slice(0, 2).map((task, index) => <button key={index} className="today-task" onClick={() => onNavigate(task.section, task.filter)}><i className={`task-dot ${task.tone}`}/><span><strong>{task.title}</strong><small>{task.detail}</small></span></button>)}
          {!tasks.length && <div className="home-empty-small">Нет записей, требующих внимания</div>}
          <button className="quiet-link" onClick={() => onNavigate('quality')}>Открыть контроль <ArrowRight size={14}/></button>
        </div>
      </section>
    </div>

    <div className="home-bottom-grid">
      <div className="home-left-column">
        <section className="profile-card">
          <div className="profile-identity"><span className="profile-avatar">{initials(actor.name)}</span><div><strong>{actor.name}</strong><small>{roles || 'Сотрудник'}</small></div></div>
          <div className="profile-facts"><span>Площадка</span><strong>{data.organization?.name || 'Предприятие'}</strong><span>Формат</span><strong>Интерактивный макет</strong><span>Режим</span><strong>Просмотр</strong></div>
          <span className="profile-tag">Без сервера и входа</span>
        </section>
        <section className="attention-card">
          <h3>Область внимания</h3>
          <p>Связанные партии и ограничения</p>
          {source ? <><button className="attention-source" onClick={() => onTrace(source.code)}><strong>{source.code}</strong><small>{source.material_name || 'Исходный материал'}</small></button><div className="attention-stats"><span><strong>{relatedFinished.length.toString().padStart(2, '0')}</strong><small>готовые партии</small></span><span><strong>{canSeeShipments ? recipients.length.toString().padStart(2, '0') : '—'}</strong><small>{canSeeShipments ? 'получателя' : 'нет доступа'}</small></span></div><button className="quiet-link" onClick={() => onTrace(source.code)}>Открыть последствия <ArrowRight size={14}/></button></> : <div className="home-empty-small">Нет доступных партий для анализа</div>}
        </section>
      </div>
      <section className="plan-card">
        <div className="card-heading"><h3>Следующие действия</h3><span>Из текущих записей</span></div>
        <div className="plan-list">{tasks.map((task, index) => <button key={index} className="plan-item" onClick={() => onNavigate(task.section, task.filter)}><span className="plan-number">{String(index + 1).padStart(2, '0')}</span><span><strong>{task.title}</strong><small>{task.detail}</small><em className={`plan-status ${task.tone}`}>Открыть запись</em></span><ArrowRight size={15}/></button>)}{!tasks.length && <div className="home-empty-small">Новых действий нет. Можно проверить журнал партий.</div>}</div>
      </section>
      <section className="lineage-card">
        <div className="lineage-visual"><span className="home-kicker">ПРОСЛЕЖИВАЕМОСТЬ ПАРТИЙ</span>
          {source && relatedFinished.length ? <div className="lineage-flow">
            <div className="lineage-nodes"><div className="lineage-node"><small>ИСХОДНОЕ СЫРЬЁ</small><strong>{source.code}</strong><span>{source.material_name}</span></div><span className="lineage-connector"/><div className="lineage-products">{relatedFinished.map(lot => <div className="lineage-node" key={lot.id}><small>ГОТОВАЯ ПАРТИЯ</small><strong>{lot.code}</strong><span>{lot.product_name}</span></div>)}</div><span className="lineage-connector"/><div className="lineage-recipients">{recipients.slice(0, 3).map(name => <div className="lineage-node" key={name}><small>ПОЛУЧАТЕЛЬ</small><strong>{name}</strong></div>)}{!recipients.length && <div className="lineage-node muted-node"><small>ПОЛУЧАТЕЛИ</small><strong>{canSeeShipments ? 'Отгрузок пока нет' : 'Доступ ограничен'}</strong></div>}</div></div>
          </div> : <div className="lineage-empty"><GitBranch size={24}/><span>Связи появятся после фактического расхода материала в производстве.</span></div>}
        </div>
        <div className="lineage-summary"><span className="home-kicker">КАРТА ВОЗДЕЙСТВИЯ</span><h3>От исходного материала до каждого получателя</h3><p>Фактический расход связывает сырьё с готовыми партиями и отгрузками. Это помогает оценить последствия дефекта.</p><div className="lineage-footer"><span>{canSeeShipments ? `${relatedFinished.length} партии · ${allocations.length} отгрузки · ${recipients.length} получателя` : `${relatedFinished.length} партии · сведения об отгрузках ограничены ролью`}</span><button className="button button-primary" onClick={() => source ? onTrace(source.code) : onNavigate('trace')}>Открыть связи <ArrowRight size={15}/></button></div></div>
      </section>
    </div>
  </div>;
}
