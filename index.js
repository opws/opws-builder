const fs = require('mz/fs');
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
    path.join(opts.baseDir,'SCHEMA_VERSION')).trim();

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

  const readLimiter = new Bottleneck(opts.maxConcurrentReads);
  const writeLimiter = new Bottleneck(opts.maxConcurrentReads);

  function pWrapped(json, metadata) {
    return `opws_jsonp_response(${json},${JSON.stringify(metadata)})`;
  }

  function processDirectory(subdir) {
    function processFile(filename, fileContent) {
      const basename = filename.replace(/\.yaml$/,'');
      const writeOperations = [];
      function writeBuilt(extension, content) {
        return writeOperations.push(writeLimiter.schedule(
          fs.writeFile,
          path.join(buildDir, subdir, basename + '.' + extension),
          content));
      }
      let obj;
      if (interpretYaml) {
        obj = yaml.load(fileContent, {schema: yaml.JSON_SCHEMA});
        if (opts.jsonSlices || opts.jsonpSlices) {
          const json = JSON.stringify(obj);
          if (opts.jsonSlices) {
            writeBuilt('json', json);
          }
          if (opts.jsonpSlices) {
            writeBuilt('jsonp', pWrapped(json, {
              domain: opts.buildDomain,
              filename: `/${buildVersion}/${subdir}/${basename}.jsonp`}));
          }
        }
      }
      if (opts.yamlSlices) {
        writeBuilt('yaml', fileContent);
      }
      return Promise.all(writeOperations).then(() => obj);
    }

    return fs.readdir(path.join(opts.baseDir,subdir)).then(files =>
      Promise.all(files.map(
        filename => readLimiter.schedule(fs.readFile,
          path.join(opts.baseDir, subdir, filename))
          .then(fileContent => processFile(filename, fileContent))))
      .then(resultObjs => {
        const writeOperations = [];
        const dirObj = {};
        for (let i = 0; i < files.length; ++i) {
          dirObj[files[i]] = resultObjs[i];
        }
        const json = JSON.stringify(dirObj);
        if (opts.jsonBundles) {
          writeOperations.push(writeLimiter.schedule(
            fs.writeFile,
            path.join(buildDir, subdir + '.json'),
            json));
        }
        if (opts.jsonpBundles) {
          writeOperations.push(writeLimiter.schedule(
            fs.writeFile,
            path.join(buildDir, subdir + '.jsonp'),
            pWrapped(json, {
              domain: opts.buildDomain,
              filename: `/${buildVersion}/${subdir}.jsonp`})));
        }
        return Promise.all(writeOperations).then(() => dirObj);
      }));
  }

  function buildAllDirectories(subdirs) {
    Promise.all(subdirs.map(processDirectory)).then(resultObjs => {
      if (opts.jsonSlices || opts.jsonpSlices) {
        const writeOperations = [];
        const bundleObj = {BUILD_TIMESTAMP: buildDateTime};
        for (let i = 0; i < subdirs.length; ++i) {
          bundleObj[subdirs[i]] = resultObjs[i];
        }
        const json = JSON.stringify(bundleObj);
        if (opts.jsonSlices) {
          writeOperations.push(writeLimiter.schedule(
            fs.writeFile,
            path.join(buildDir, 'bundle.json'),
            json));
        }
        if (opts.jsonpSlices) {
          writeOperations.push(writeLimiter.schedule(
            fs.writeFile,
            path.join(buildDir, 'bundle.jsonp'),
            pWrapped(json, {
              domain: opts.buildDomain,
              filename: `/${buildVersion}/bundle.jsonp`})));
        }
        return Promise.all(writeOperations).then(() => bundleObj);
      }
    });
  }

  function writeTimestampFiles() {
    Promise.all([
      writeLimiter.schedule(fs.writeFile, 'BUILD_TIMESTAMP.txt',
        buildDateTime),
      writeLimiter.schedule(fs.writeFile, 'BUILD_TIMESTAMP.jsonp',
        pWrapped(JSON.stringify(buildDateTime), {
          domain: opts.buildDomain,
          filename: `/${buildVersion}/BUILD_TIMESTAMP.jsonp`}))]);
  }

  buildAllDirectories(['profiles','legacies']).then(writeTimestampFiles);
}

exports.build = build;