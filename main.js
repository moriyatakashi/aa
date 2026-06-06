const table = document.getElementById('grid');
for (let r = 0; r < 16; r++) {
  const tr = document.createElement('tr');
  for (let c = 0; c < 16; c++) {
    const td = document.createElement('td');
    td.dataset.r = r;
    td.dataset.c = c;
    tr.appendChild(td);
  }
  table.appendChild(tr);
}
