import { Promise } from 'bluebird';
import * as kafka from 'kafka-node';
import * as _ from 'lodash';
import { Observable } from 'rx';

var producerPromise;

/**
* Create an Observable stream from a kafka consumer
*/
var createStreamFromConsumer = function (kafkaConsumer) {
  return Observable.create(observer => {
    kafkaConsumer.on('message', message => observer.onNext(message.value));
    kafkaConsumer.on('error', error => observer.onError(error));
    kafkaConsumer.on('offsetOutOfRange', topic => observer.onError(topic));
  });
};

export class KafkaAdapter {
  constructor(zookeeperAddress) {
    this.zookeeperAddress = zookeeperAddress;
  }
  
  /**
  * Create a new Kafka Producer or returns a promise for an existing one
  * Sets the producer promise to the output of this (we should only have one producer)
  * 
  * @returns: Promise with the producer. Resolves when the producer is ready. <Promise<kafka.Producer>>
  */
  initializeProducer () {
    var producerClientId = 'producer-' + Math.floor(Math.random() * 10000);
    var client = new kafka.Client(this.zookeeperAddress, producerClientId);
    var producer = new kafka.Producer(client);
    
    producerPromise = producerPromise || new Promise((resolve, reject) => {
      producer.on('ready', () => {
        resolve(producer);
      });
      producer.on('error', (err) => {
        reject(err);
      });
    });
    return producerPromise;
  }

  /**
  * Create an Observable stream for a given topic
  * @param {string} topic The topic name
  * @param {object} optional config to pass in for the consumer
   *@returns {Observable} 
  */
  createMessageStreamForTopic (topic, configs) {
    var clientId = 'worker-' + Math.floor(Math.random() * 10000);
    var consumerClient = new kafka.Client(this.zookeeperAddress, clientId);
    var topicConsumer = new kafka.HighLevelConsumer(
      consumerClient,
      [{topic: topic}],
      configs || {}
    );
    return createStreamFromConsumer(topicConsumer);
  }
  
  /**
  * is the message a request?
  * @param{string} message js object representing Kafka message payload
  */
  static isMessageRequest (message) {
    return _.contains(message, 'response_topic');
  }
  
  /**
  * generate an object representing a response to write back to kafka
  * @param {object: {data: [key:string]: any}} response - the response to the request
  * @param {object: {correlation_id: string, response_topic: string}} request
  * @returns {object: {response: correlation_id: errors?:}}
  */
  createMessageResponseObject (response, request) {
    var messageResponseObject = {
      errors: [],
      response
    }

    if (!request.correlation_id) {
      messageResponseObject.errors.push('Invalid Request: Request is missing correlation_id. Request is ' + request);
    } else {
      messageResponseObject.correlation_id = request.correlation_id;
    }

    if (!request.request_id) {
      messageResponseObject.errors.push('Invalid Request: Request is missing request_id. Request is ' + request);
    } else {
      messageResponseObject.request_id = request.request_id;
    }

    if(messageResponseObject.errors.length === 0)
      delete messageResponseObject.errors;

    return messageResponseObject;
  }
  
  /**
  * write the given response body to the given kafka topic for the request w/ the correlation_id
  * @param {object} response - js object representing json response
  * @param {object: {correlation_id: string, response_topic: string, body: string}} request - js object representing request message on kafka
  * @returns {Promise<string>} Kafka's response to sending the message
  * @throws {Error} - if the request doesn't have a response_topic, throw an error
  */
  writeResponseForRequest (response, request) {
    if (!request.response_topic) {
      return Promise.reject('Request is missing a response_topic. Request: %j');
    }
    else {
      var kafkaMessageObject = this.createMessageResponseObject(response, request);
      return this.writeMessageToTopic(JSON.stringify(kafkaMessageObject), request.response_topic);
    }
  }
  
  /**
  * write the given message to the kafka topic
  * @param {string} messageString - message to write on topic
  * @param {string} topic - Kafka topic to write to
  * @param {object {attemptNumber: maxAttempts: withBackoff}} configs
        attemptNumber: int - current attempt number
        maxAttempts: int - maximum number of attempts
        withBackoff - boolean - whether or not to use exponential backoff
  * @returns {Promise<String>} response of Kafka to a successful write
  */
  writeMessageToTopic (messageString, topic, configs = {}) {
    var attemptNumber = configs.attemptNumber || 0;
    var maxAttempts = configs.maxAttempts || 10;
    var withBackoff = configs.withBackoff !== undefined ? configs.withBackoff : true;
    return this.initializeProducer().then((producer) => {
      return new Promise((resolve, reject) => {
        producer.send([{
          topic: topic,
          messages: [messageString]
        }], (err, data) => {
          if (err) {
            // retry if there was an error w/ exponential backoff. Wrap the retry in a promise
            if (attemptNumber < maxAttempts - 1) {
              if (withBackoff) {
              setTimeout(
                () => resolve(this.writeMessageToTopic(messageString, topic, {
                  attemptNumber: attemptNumber + 1,
                  maxAttempts,
                  withBackoff
                })),
                (Math.pow(2,attemptNumber)*1000) + (Math.round(Math.random() * 1000))
              );
              } else {
                resolve(this.writeMessageToTopic(messageString, topic, {
                  attemptNumber: attemptNumber + 1,
                  maxAttempts,
                  withBackoff
                }));
              }
            } else {
              reject(err);
            }
          }
          else {
            resolve(data);
          }
        });
      })
    });
  }
  
  /**
  * create Kafka topics
  */
  createTopics (...topicNames) {
    return this.initializeProducer().then((producer) => {
      return new Promise((resolve, reject) => {
        producer.createTopics(topicNames, false, (err, data) => {
          if (err) {
            reject(err);
          }
          else {
            resolve(data);
          }
        });
      });
    });
  }
};
