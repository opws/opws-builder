"use strict";

const fs = require('fs-promise');
const path = require('path');
const Bottleneck = require('bottleneck');
const yaml = require('js-yaml');

function build(opts) {
  const buildStartTime = new Date();
  const buildDateTime = buildStartTime.toISOString();

  opts = opts || {};
  function defineDefault(name, value) {
    if (typeof opts[name] == 'undefined') {
      opts[name] = value;
    }
  }

  // parameters
  defineDefault('baseDir', '.');
  defineDefault('outDir', 'build');
  defineDefault('buildDomain', 'builds.opws.org');
  defineDefault('expectedVersion', 'v0.1');

  // tuning
  defineDefault('maxConcurrentReads', 1000);
  defineDefault('maxConcurrentWrites', 1000);

  // output
  defineDefault('jsonSlices', true);
  defineDefault('jsonpSlices', true);
  defineDefault('yamlSlices', true);
  defineDefault('jsonBundles', true);
  defineDefault('jsonpBundles', true);

  const baseSchemaVersion = fs.readFileSync(
    path.join(opts.baseDir,'SCHEMA_VERSION'),'utf8').trim();

  // We'll redo the expectation logic the next time we update the schema;
  // for now, we essentially just check if it's v0.1, so we don't
  // inadvertently try to build a complete refactor with v0.1's logic
  if (baseSchemaVersion != opts.expectedVersion) {
    console.error('Error: unexpected SCHEMA_VERSION in dataset');
    console.error('Update opws-builder or set OPWS_EXPECTED_SCHEMA_VERSION');
    process.exit(1);
  }

  const buildVersion = baseSchemaVersion + '/latest';
  const buildDir = path.join(opts.outDir, buildVersion);

  const interpretYaml = opts.jsonSlices || opts.jsonpSlices ||
    opts.jsonBundles || opts.jsonpBundles;

  function pWrapped(json, metadata) {
    return `opws_jsonp_response(${json},${JSON.stringify(metadata)})`;
  }

  const readLimiter = new Bottleneck(opts.maxConcurrentReads);
  const writeLimiter = new Bottleneck(opts.maxConcurrentReads);

  function readFile(name) {
    return readLimiter.schedule(fs.readFile, name);
  }

  function writeBuildFile(name, data) {
    return writeLimiter.schedule(fs.writeFile,
      path.join(buildDir, name), data);
  }

  function makeBundle(bundleName, keys, valueMapFunc, etc) {
    const bundleObj = etc.base || {};
    const keyMapFunc = etc.keyMapFunc || (x=>x);
    return Promise.all(keys.map(valueMapFunc)).then(values => {
      const writeOperations = [];
      if (opts.jsonSlices || opts.jsonpSlices) {
        for (let i = 0; i < keys.length; ++i) {
          bundleObj[keyMapFunc(keys[i])] = values[i];
        }
        const json = JSON.stringify(bundleObj);
        if (opts.jsonSlices) {
          writeOperations.push(writeBuildFile(bundleName + '.json', json));
        }
        if (opts.jsonpSlices) {
          writeOperations.push(writeBuildFile(bundleName + '.jsonp',
            pWrapped(json, {
              domain: opts.buildDomain,
              filename: `/${buildVersion}/${bundleName}.jsonp`})));
        }
      }
      return Promise.all(writeOperations).then(() => bundleObj);
    });
  }

  function processDirectory(subdir) {
    function processFile(filename, fileContent) {
      const basename = filename.replace(/\.yaml$/,'');
      const writeOperations = [];
      function makeSlice(extension, content) {
        return writeOperations.push(writeBuildFile(
          path.join(subdir, basename + '.' + extension),
          content));
      }
      let obj;
      if (interpretYaml) {
        obj = yaml.load(fileContent, {schema: yaml.JSON_SCHEMA});
        if (opts.jsonSlices || opts.jsonpSlices) {
          const json = JSON.stringify(obj);
          if (opts.jsonSlices) {
            makeSlice('json', json);
          }
          if (opts.jsonpSlices) {
            makeSlice('jsonp', pWrapped(json, {
              domain: opts.buildDomain,
              filename: `/${buildVersion}/${subdir}/${basename}.jsonp`}));
          }
        }
      }
      if (opts.yamlSlices) {
        makeSlice('yaml', fileContent);
      }
      return Promise.all(writeOperations).then(() => obj);
    }

    return fs.ensureDir(path.join(buildDir,subdir))
      .then(() => fs.readdir(path.join(opts.baseDir,subdir)))
      .then(files => makeBundle(subdir, files, filename =>
        readFile(path.join(opts.baseDir, subdir, filename))
          .then(fileContent => processFile(filename, fileContent)),
        {keyMapFunc: x => x.replace(/\.yaml$/,'')}));
  }

  function writeTimestampFiles() {
    Promise.all([
      writeBuildFile('BUILD_TIMESTAMP.txt',
        buildDateTime),
      writeBuildFile('BUILD_TIMESTAMP.jsonp',
        pWrapped(JSON.stringify(buildDateTime), {
          domain: opts.buildDomain,
          filename: `/${buildVersion}/BUILD_TIMESTAMP.jsonp`}))]);
  }

  fs.ensureDir(buildDir)
    .then(makeBundle('bundle',
      ['profiles','legacies'], processDirectory,
      {base: {BUILD_TIMESTAMP: buildDateTime}}))
    .then(writeTimestampFiles);
}

exports.build = build;
