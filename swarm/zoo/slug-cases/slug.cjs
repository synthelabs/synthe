// Turns a title into a URL slug.
function slug(title) {
  let s = title;
  s = s.trim();
  s = s.replace(/\s+/g, "-");
  return s;
}

module.exports = slug;
