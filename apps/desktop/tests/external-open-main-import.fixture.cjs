// Inspector has no ESM import callback; this owned test module supplies one.
module.exports = specifier => import(specifier);
