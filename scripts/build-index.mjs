import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as yaml from "js-yaml";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderSections(categories) {
  return categories
    .map((category) => {
      const items = category.items
        .map(
          (item) =>
            `    <a class="nav-item" href="${escapeHtml(item.href)}"><span class="nav-code">${escapeHtml(item.code)}</span><span class="nav-desc">${escapeHtml(item.desc)}</span></a>`
        )
        .join("\n");
      return `  <div class="cat-label">${escapeHtml(category.label)}</div>\n  <div class="nav-list">\n${items}\n  </div>`;
    })
    .join("\n\n");
}

const nav = yaml.load(readFileSync(path.join(rootDir, "nav.yml"), "utf8"));
const template = readFileSync(path.join(rootDir, "index.template.html"), "utf8");

const html = template.replace("<!--NAV_SECTIONS-->", renderSections(nav.categories));

writeFileSync(path.join(rootDir, "index.html"), html);
console.log("index.html generated from nav.yml");
