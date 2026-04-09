export default {
  dirname(path) {
    const value = String(path || "");
    const index = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
    return index >= 0 ? value.slice(0, index) : ".";
  },
  normalize(path) {
    return String(path || "");
  },
};
