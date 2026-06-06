fetch('map.json')
  .then(res => res.json())
  .then(({ grid, colors }) => {
    const table = document.getElementById('grid');
    grid.forEach((row, r) => {
      const tr = document.createElement('tr');
      row.forEach((cell, c) => {
        const td = document.createElement('td');
        td.dataset.r = r;
        td.dataset.c = c;
        if (colors[cell]) td.style.background = colors[cell];
        tr.appendChild(td);
      });
      table.appendChild(tr);
    });
  });
