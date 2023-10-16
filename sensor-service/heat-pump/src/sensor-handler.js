'use strict';

import {DateTime} from 'luxon';
import {anIntegerWithPrecision} from './random.js';
import {EventEmitter} from 'events';
import {sensors} from './server.js';

// list of heatpump used to check differences 
var old_sensors_list = [];

// error state 
const ERROR = -1; 

class ValidationError extends Error {
  #message;

  constructor(msg) {
    super(msg);
    this.#message = msg;
  }

  get message() {
    return this.#message;
  }
}

/**
 * A WebSocket handler to deal with weather subscriptions.
 */
export class SensorHandler extends EventEmitter {
  #ws;
  #config;
  #name;
  #timeout;
  #buffer;
  #death;

  /**
   * Instances a new weather handler.
   * @param ws {WebSocket} The WebSocket client
   * @param config {{iface:string,port:number,failures:boolean,delays:boolean,frequency:number,timeToLive:number}} Configuration
   * @param name {string} A name for this handler
   */
  constructor(ws, config, name) {
    super();
    this.#ws = ws;
    this.#config = config;
    this.#name = name;
    this.#buffer = [];
  }

  get name() {
    return this.#name;
  }

  /**
   * Handles incoming messages.
   * @param msg {string} An incoming JSON message
   */
  onMessage(msg) {
    let json;
    try {
      json = this._validateMessage(msg);
    } catch (e) {
      this._send({error: e.message});
      return;
    }

    // @formatter:off
    switch (json.type) {
      case 'subscribe': this._onSubscribe(); break;
      case 'unsubscribe': this._onUnsubscribe(); break;
    }
    // @formatter:on
  }

  stop() {
    if (this.#timeout) {
      clearTimeout(this.#timeout);
    }
    if (this.#death) {
      clearTimeout(this.#death);
    }
  }

  start() {
    console.debug('New connection received', {handler: this.#name});

    // simulate a client disconnection
    if (this.#config.failures && this.#config.timeToLive > 0) {
      this._scheduleDeath();
    }
  }

  _scheduleDeath() {
    const secs = (Math.random() * this.#config.timeToLive + 5).toFixed(0);
    
    // simulates error states
    setTimeout(() => {
      var sensorDead = Number((Math.random()*(sensors.length-1)).toFixed(0));
      sensors[sensorDead].state = ERROR;
      this._scheduleDeath();
    }, secs * 5000);

    // stops the container
    this.#death = setTimeout(() => {
      console.error('✝ Farewell and goodnight', {handler: this.#name});
      this.#ws.close();
      this.stop();
      this.emit('error', 'Simulated death', {handler: this.#name});
      process.exit();
    }, secs * 15000);
  }

  /**
   * Validates an incoming message.
   * @param msg {string} Any message string that can be parsed as JSON
   * @return {any} An object representing the incoming message
   * @private
   */
  _validateMessage(msg) {
    if (!msg) {
      throw new ValidationError('Invalid inbound message');
    }
    const json = JSON.parse(msg);
    if (json.type !== 'subscribe' && json.type !== 'unsubscribe') {
      throw new ValidationError('Invalid message type');
    }
    // valid messages only if target == heatpump
    if (json.target !== 'heatpump') {
      throw new ValidationError('Invalid subscription target');
    }
    if (json.list !== null){
      sensors.splice(0, sensors.length);
      json.list.forEach(item => sensors.push(item));
      console.log(sensors);
    }
    return json;
  }

  /**
   * Generates a random delay in milliseconds.
   * @return {number} Milliseconds
   * @private
   */
  _someMillis() {
    return anIntegerWithPrecision(this.#config.frequency, 0.2);
  }

  /**
   * Sends the sensors list.
   * @private
   */
  _sendList() {
    const msg =  {type: 'sensors_list', dateTime: DateTime.now().toISO(), list : sensors};

    // message is always appended to the buffer
    this.#buffer.push(msg);

    // messages are dispatched immediately if delays are disabled or a random number is
    // generated greater than `delayProb` messages
    //if (!this.#config.delays || Math.random() > this.#config.delayProb) {
    for (const bMsg of this.#buffer) {
      this._send(bMsg);
    }
    this.#buffer = [];
    /*} else {
      console.info(`💤 Due to network delays, ${this.#buffer.length} messages are still queued`, {handler: this.#name});
    }*/
  } 

  /**
   * Sends any message through the WebSocket channel.
   * @param msg Any message
   * @private
   */
  _send(msg) {
    if (this.#config.failures && Math.random() < this.#config.errorProb) {
      console.info('🐛 There\'s a bug preventing the message to be sent', {handler: this.#name});
      const callback = () => {
        this._send(msg);
      }
      setTimeout(callback, this._someMillis());
      return;
    }
    console.debug('💬 Dispatching message', {handler: this.#name});
    this.#ws.send(JSON.stringify(msg));
  }

  _onSubscribe() {
    if (this.#timeout) {
      return;
    }
    console.debug('Subscribing to state', {handler: this.#name});
    const callback = () => {
      // check if the the heatmpums list is changed 
      if (JSON.stringify(old_sensors_list) !== JSON.stringify(sensors)) {
        old_sensors_list = JSON.parse(JSON.stringify(sensors));   // update the list
        this._sendList();    
      }
      this.#timeout = setTimeout(callback, this._someMillis()); 
    };
    this.#timeout = setTimeout(callback, 0);
  }

  _onUnsubscribe() {
    if (!this.#timeout) {
      return;
    }
    clearTimeout(this.#timeout);
    this.#timeout = 0;
    this._send({ack: true});
  }
}
