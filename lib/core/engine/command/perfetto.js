import intel from 'intel';
const log = intel.getLogger('browsertime.command.perfetto');
import { join } from 'node:path';
import { writeFile, unlink } from 'node:fs';
import { pathToFolder } from '../../../support/pathToFolder.js';
import { isAndroidConfigured, Android } from '../../../android/index.js';
/**
 * Manages the collection of perfetto traces on Android.
 *
 * @class
 * @hideconstructor
 */

const defaultConfig =
`buffers: {
    size_kb: 522240
    fill_policy: DISCARD
}
buffers: {
    size_kb: 2048
    fill_policy: DISCARD
}
data_sources: {
    config {
        name: "android.packages_list"
        target_buffer: 1
    }
}
data_sources: {
    config {
        name: "linux.process_stats"
        target_buffer: 1
        process_stats_config {
            scan_all_processes_on_start: true
        }
    }
}
data_sources: {
    config {
        name: "linux.ftrace"
        ftrace_config {
            ftrace_events: "power/suspend_resume"
            ftrace_events: "power/cpu_frequency"
            ftrace_events: "power/cpu_idle"
            ftrace_events: "regulator/regulator_set_voltage"
            ftrace_events: "regulator/regulator_set_voltage_complete"
            ftrace_events: "power/clock_enable"
            ftrace_events: "power/clock_disable"
            ftrace_events: "power/clock_set_rate"
        }
    }
}
duration_ms: 60000`

export class PerfettoTrace {
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
  }

  async uploadConfigFile(android, config) {
    let dataDir = this.storageManager.directory;
    let destinationFilename = join(dataDir, `perfetto-config.txt`);
    function callback(err) {
      if (err) {
        console.error(err);
      }
    }
    await writeFile(destinationFilename, config, callback);
    await android._uploadFile(destinationFilename, "/data/local/tmp/config.txt");
    return unlink(destinationFilename, callback);
  }

  async downloadTrace(android) {
    let dataDir = this.storageManager.directory;
    let destinationFilename = join(dataDir, `trace-${this.index}.perfetto`);
    let deviceTraceFilename = '/data/misc/perfetto-traces/trace';
    log.info(
      `Downloading perfetto trace from ${deviceTraceFilename} to ${destinationFilename}`
    );
    return android._downloadFile(deviceTraceFilename, destinationFilename);
  }

  /**
   * Begin Perfetto Trace Collection.
   *
   * @async
   * @returns {Promise<void>} A promise that resolves when tracing is finished.
   * @throws {Error} Throws an error if the configuration is not set for perfetto tracing.
   */
  async collect() {
    if (isAndroidConfigured(this.options)) {
      const android = new Android(this.options);

      // Check if perfetto is enabled on this device.
      const perfettoEnabled = await android._runCommandAndGet(`getprop persist.traced.enable`)
      console.log(JSON.stringify(perfettoEnabled));
      if (perfettoEnabled !== "1") {
        log.info(`Disabling Perfetto: persist.traced.enable=${perfettoEnabled}`);
        return;
      }

      // Create the trace config on the device.  
      log.info('Creating perfetto config on device.');
      await android._runCommandAndGet(`cat <<EOF>/sdcard/browsertime-perfetto-config.txt\n${defaultConfig}\nEOF`);

      // Start perfetto trace.
      log.info('Starting perfetto tracing.');
      const output = await android._runCommandAndGet('cat /sdcard/browsertime-perfetto-config.txt | perfetto -c - --txt -o /data/misc/perfetto-traces/trace');
      log.info(`perfetto output:\n${output}`);
      log.info('Perfetto tracing finished.');

      // Remove the config file.
      log.info('Removing trace config from device.');
      await android.removeFileOnSdCard('browsertime-perfetto-config.txt');

      // Download perfetto trace.
      log.info('Downloading perfetto trace.');
      return this.downloadTrace(android);
    } else {
      throw new Error('Perfetto tracing is only available on Android.');
    }
  }
}
