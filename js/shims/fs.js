function unsupported(name) {
  throw new Error(`fs.${name} is not available in the browser probe bundle`);
}

export default {
  readFileSync() {
    unsupported("readFileSync");
  },
  readFile(_path, callback) {
    const error = new Error("fs.readFile is not available in the browser probe bundle");
    if (typeof callback === "function") callback(error);
  },
};
