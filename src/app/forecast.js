export function createForecastView() {
  const $ = (id) => document.getElementById(id);
  const element = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const chart = $("forecast-chart");
  const body = $("forecast-rows");
  const scroller = document.querySelector(".forecast-ledger .table-scroll");
  function highlight(index, bringToFront = false) {
    for (const node of chart.querySelectorAll("[data-row-index]"))
      node.classList.toggle("is-hovered", Number(node.dataset.rowIndex) === index);
    for (const row of body.querySelectorAll("tr[data-row-index]"))
      row.classList.toggle("is-hovered", Number(row.dataset.rowIndex) === index);
    if (bringToFront && index >= 0) {
      const circle = chart.querySelector(`circle[data-row-index="${index}"]`);
      const label = chart.querySelector(`text[data-row-index="${index}"]`);
      if (circle && label) chart.append(circle, label);
    }
  }
  function reveal(row) {
    const bounds = scroller.getBoundingClientRect();
    const top = bounds.top + (scroller.querySelector("thead")?.getBoundingClientRect().height ?? 0);
    const rowBounds = row.getBoundingClientRect();
    if (rowBounds.top < top) scroller.scrollTop -= top - rowBounds.top;
    else if (rowBounds.bottom > bounds.bottom) scroller.scrollTop += rowBounds.bottom - bounds.bottom;
  }
  function svgNode(tag, attrs) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return node;
  }
  function drawChart(rows) {
    for (const node of [...chart.children]) if (!["title", "desc"].includes(node.localName)) node.remove();
    if (!rows.length) return;
    const points = rows.map((row) => ({ x: Date.parse(row.at), y: row.sum * 100, row }));
    let minX = points[0].x, maxX = points[0].x, minY = 0, maxY = 0;
    for (const point of points) { minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x); minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y); }
    const { width, height } = chart.viewBox.baseVal;
    const range = maxY - minY;
    if (!Number.isFinite(range)) return;
    const x = (value) => ((value - minX) / (maxX - minX || 1)) * width;
    const y = (value) => height - ((value - minY) / (range || 1)) * height;
    chart.append(svgNode("line", { x1: 0, x2: width, y1: y(0), y2: y(0), class: "zero-line" }));
    const bind = (node, index) => {
      node.dataset.rowIndex = index;
      node.addEventListener("pointerenter", () => { const row = body.querySelector(`tr[data-row-index="${index}"]`); if (row) reveal(row); highlight(index, true); });
      node.addEventListener("pointerleave", () => highlight(-1));
    };
    let path = `M ${x(points[0].x)} ${y(points[0].y)}`;
    for (const point of points.slice(1)) path += ` H ${x(point.x)} V ${y(point.y)}`;
    chart.append(svgNode("path", { d: path, class: "balance-line", fill: "none" }));
    let prevY = null;
    const visible = points.length > 200 ? [...points.slice(0, 100).map((point, index) => ({ point, index })), ...points.slice(-100).map((point, offset) => ({ point, index: points.length - 100 + offset }))] : points.map((point, index) => ({ point, index }));
    for (const { point, index } of visible) {
      const cx = x(point.x), cy = y(point.y), cls = point.y < 0 ? "minus" : "plus";
      const label = svgNode("text", { class: `${cls} ${point.y > prevY ? "up" : "down"}`, x: cx, y: cy });
      label.textContent = point.row.name; bind(label, index);
      const circle = svgNode("circle", { class: cls, cx, cy }); bind(circle, index); chart.append(circle, label);
      if (prevY !== null && ((point.y >= 0 && prevY <= 0) || (point.y <= 0 && prevY >= 0))) {
        const zy = cy > height / 2 ? height - 20 : 20;
        const zero = svgNode("text", { class: `${point.y > prevY ? "plus" : "minus"} ${cy > height / 2 ? "down" : "up"}`, x: cx, y: zy });
        zero.textContent = point.row.at;
        chart.append(zero, svgNode("line", { x1: cx, x2: cx, y1: cy, y2: zy, class: "zero-line" }));
      }
      prevY = point.y;
    }
  }
  let scrollFrame = 0, previousScrollTop = scroller.scrollTop;
  scroller.addEventListener("scroll", () => {
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      const scrollTop = scroller.scrollTop, direction = Math.sign(scrollTop - previousScrollTop);
      previousScrollTop = scrollTop;
      const bounds = scroller.getBoundingClientRect(), top = bounds.top + scroller.querySelector("thead").getBoundingClientRect().height, bottom = bounds.bottom;
      const rows = body.querySelectorAll("tr[data-row-index]");
      let low = 0, high = rows.length;
      while (low < high) { const mid = (low + high) >>> 1; if (rows[mid].getBoundingClientRect().bottom > top) high = mid; else low = mid + 1; }
      const first = rows[low]; if (!first || first.getBoundingClientRect().top >= bottom) return;
      low = 0; high = rows.length;
      while (low < high) { const mid = (low + high) >>> 1; if (rows[mid].getBoundingClientRect().top < bottom) low = mid + 1; else high = mid; }
      const last = rows[low - 1], selected = body.querySelector("tr[data-row-index].is-hovered");
      if (selected) { const b = selected.getBoundingClientRect(); if (b.top >= top && b.bottom <= bottom) return; if (b.top < top) { highlight(Number(first.dataset.rowIndex)); return; } if (b.bottom > bottom) { highlight(Number(last.dataset.rowIndex)); return; } }
      highlight(Number((direction < 0 ? last : first).dataset.rowIndex));
    });
  });
  return {
    status(text) { $("forecast-status").textContent = text; },
    render(result, { from, to, amount }) {
      $("anchor-amount").textContent = amount;
      $("anchor-date").textContent = result.anchor ? result.anchor.at : "Add an actual balance to establish an anchor";
      const last = result.rows.at(-1);
      $("closing-amount").textContent = last ? last.sum : "—";
      $("closing-date").textContent = last ? last.at : "No events in this horizon";
      $("forecast-row-count").textContent = `· ${result.rows.length} rows`;
      body.replaceChildren();
      let startedPositive = amount > 0, firstCrossDate = null, isFirstRow = true;
      for (const [index, row] of result.rows.entries()) {
        const tr = element("tr"); tr.dataset.rowIndex = index;
        tr.addEventListener("pointerenter", () => highlight(index, true)); tr.addEventListener("pointerleave", () => highlight(-1));
        tr.append(element("td", row.at), element("td", row.sum, "numeric"), element("td", `${row.name} (${row.amount})`)); body.append(tr);
        if (firstCrossDate === null && !isFirstRow) { if (startedPositive ? row.sum <= 0 : row.sum >= 0) firstCrossDate = row.at; } else isFirstRow = false;
      }
      if (firstCrossDate !== null) $("first-crosses-zero").textContent = firstCrossDate;
      if (!result.rows.length) { const td = element("td", "No forecast rows in this date range. Add records or adjust the horizon.", "empty-table"); td.colSpan = 3; const tr = element("tr"); tr.append(td); body.append(tr); }
      drawChart(result.rows);
      $("forecast-status").textContent = `${result.rows.length} exact ledger rows · after ${from} through ${to}`;
    },
  };
}
