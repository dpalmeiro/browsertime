import intel from 'intel';
const log = intel.getLogger('browsertime.command.perfetto');
import get from 'lodash.get';
import { join } from 'node:path';
import { execa } from 'execa';
import { 
  writeFile, 
  unlink,
  existsSync, 
  renameSync
} from 'node:fs';
import { pathToFolder } from '../../../support/pathToFolder.js';
import { isAndroidConfigured, Android } from '../../../android/index.js';
const delay = ms => new Promise(res => setTimeout(res, ms));
/**
 * Manages the collection of perfetto traces on Android.
 *
 * @class
 * @hideconstructor
 */

const defaultOptions='--call-graph fp --duration 240 -f 1000 --trace-offcpu -e cpu-clock';

/**
 * Timeout a promise after ms. Use promise.race to compete
 * about the timeout and the promise.
 * @param {promise} promise - The promise to wait for
 * @param {int} ms - how long in ms to wait for the promise to fininsh
 * @param {string} errorMessage - the error message in the Error if we timeouts
 */
async function timeout(promise, ms, errorMessage) {
  let timer;

  return Promise.race([
    new Promise((resolve, reject) => {
      timer = setTimeout(reject, ms, new Error(errorMessage));
      return timer;
    }),
    promise.then(value => {
      clearTimeout(timer);
      return value;
    })
  ]);
}

export class SimplePerfProfiler {
  constructor(browser, index, storageManager, options) {
    /**
     * @private
     */
    this.browser = browser;
    /**
     * @private
     */
    this.storageManager = storageManager;
    /**
     * @private
     */
    this.options = options;
    /**
     * @private
     */
    this.index = index;
    /**
     * @private
     */
    this.running = false;
  }

  /**
   * Start Simpleperf profiling.
   *
   * @async
   * @returns {Promise<void>} A promise that resolves when simpleperf has started profiling.
   * @throws {Error} Throws an error if app_profiler.py fails to execute.
   */
  async start(profilerOptions=defaultOptions) {
    if (!isAndroidConfigured(this.options)) {
      throw new Error('Simpleperf profiling is only available on Android.');
    }

    log.info('Starting simpleperf profiler.');

    // Create empty subdir for simpleperf data.
    let dirname = `simpleperf-${this.index}`;
    let counter=1;
    do {
      log.info(`Checking if ${dirname} exists...`);
      if (existsSync(join(this.storageManager.directory, dirname))) {
        dirname =`simpleperf-${this.index}.${counter}`;
        counter++;
        log.info(`Directory already exists.`);
      } else {
        this.dataDir = await this.storageManager.createSubDataDir(dirname);
        log.info(`Creating subdir ${this.dataDir}.`);
        break;
      }
    } while (1);

    const packageName =
      this.options.browser === 'firefox'
      ? get(this.options, 'firefox.android.package')
      : get(this.options, 'chrome.android.package');

    let ndkPath = this.options.androidNDK;
    let cmd = `${ndkPath}/simpleperf/app_profiler.py`;
    let args = [
      '-p',
      packageName,
      '-r',
      profilerOptions,
      '--log',
      'debug',
      '-o',
      join(this.dataDir, 'perf.data')
    ];
    this.simpleperfProcess = execa(cmd, args);

    log.info('After adb command');

    let simpleperfPromise = new Promise((resolve, reject) => {
      let stderrStream = this.simpleperfProcess.stderr;
      stderrStream.on('data', data => {
        log.info(data.toString());
        if (/command 'record' starts running/.test(data.toString())) {
          this.running = true;
          stderrStream.removeAllListeners('data');
          return resolve();
        }
        if (/Failed to record profiling data./.test(data.toString())) {
          this.running = false;
          log.info("Error starting simpleperf: " + data.toString());
          throw new Error('Simpleperf failed to start.');
        }
      });
    });

    // Set a 30s timeout for starting simpleperf.
    return timeout(simpleperfPromise, 30000, "Simpleperf timed out.");
  }

  /**
   * Stop Simpleperf profiling.
   *
   * @async
   * @returns {Promise<void>} A promise that resolves when simpleperf has stopped profiling
   *                          and collected profile data.
   * @throws {Error} Throws an error if app_profiler.py fails to execute.
   */
  async stop() {
    if (!isAndroidConfigured(this.options)) {
      throw new Error('Simpleperf profiling is only available on Android.');
    }

    if (!this.running) {
      throw new Error('Simpleperf profiling was not started.');
    }

    log.info('Stop simpleperf profiler.');
    this.simpleperfProcess.kill('SIGINT');

    log.info('After SIGINT');

    // Return when "profiling is finished." is found, or an error.
    return new Promise((resolve, reject) => {
      let stderrStream = this.simpleperfProcess.stderr;
      log.info('Reading stderr.');
      stderrStream.on('data', data => {
        log.info(data.toString());
        if (/Start monitoring process/.test(data.toString())) {

        }
        if (/profiling is finished./.test(data.toString())) {
          stderrStream.removeAllListeners('data');

          // There is no way to specify the output of binary_cache, so manually move
          // it into the data directory.
          renameSync('binary_cache', join(this.dataDir, 'binary_cache'));
          return resolve();
        }
      });
      stderrStream.once('error', reject);
    });
  }
}
