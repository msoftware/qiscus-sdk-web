import _ from 'lodash'
import moment from 'moment'
import HttpAdapter from './adapters/http';
import UserAdapter from './adapters/user';
import RoomAdapter from './adapters/room';
import TopicAdapter from './adapters/topic';
import {EventEmitter} from 'events';

class qiscusSDK extends EventEmitter {

  constructor() {
    super();
    const self = this;
    // Chat Related properties
    self.rooms    = null;
    self.selected = null;
    self.pendingCommentId = 0;

    // User Properties
    self.userData = null;

    // SDK Configuration
    self.baseURL     = null;
    self.HTTPAdapter = null;
    self.isLogin     = false;
    self.options     = {};
    self.isLoading   = false;

    //////////////////////////// EVENTS OBSERVERS /////////////////////////////
    /**
     * This event will be called when there's new post messages
     * If use pass a callback when initiating SDK, we'll call that function
     * @param {string} data - JSON Response from SYNC API
     * @return {void} 
    */
    self.on('newmessages', function(data){
      // let's convert the data into something we can use
      // first we need to make sure we sort this data out based on room_id
      _.map(data, (comment) => {
        let theRoom = _.find(self.rooms, {id: comment.room_id});
        if( theRoom ) theRoom.receiveComments(comment);
        // Code below means the room does not exist yet, let's create
        theRoom = new Room({id: comment.room_id, name: comment.email});
        theRoom.receiveComments(comment);
      })
      if(self.options.newMessagesCallBack) self.options.newMessagesCallBack(data);
    })

    /**
     * This event will be called when login is sucess
     * Basically, it sets up necessary properties for qiscusSDK
     */
    self.on('login-success', function(response){
      self.isLogin  = true;
      self.userData = response.results.user;

      // now that we have the token, etc, we need to set all our adapters
      ///////////////// API CLIENT /////////////////
      self.HTTPAdapter = new HttpAdapter(self.baseURL);
      self.HTTPAdapter.setToken(self.userData.token);

      //////////////// CORE BUSINESS LOGIC ////////////////////////
      // this.messageAdapter   = new MessageAdapter(this.HTTPAdapters);
      self.userAdapter      = new UserAdapter(self.HTTPAdapter);
      self.roomAdapter      = new RoomAdapter(self.HTTPAdapter);
      self.topicAdapter     = new TopicAdapter(self.HTTPAdapter);
    })
  }

  /**
  * Setting Up User Credentials for next API Request
  * @param {string} email - client email (will be used for login or register)
  * @param {string} key - client unique key
  * @param {string} username - client username
  * @param {string} avatar_url - the url for chat avatar (optional)
  * @return {void}
  */
  setUser(email, key, username, avatar_url) {
    this.email      = email;
    this.key        = key;
    this.username   = username;
    this.avatar_url = avatar_url;
  }
  
  /**
  * Initializing the SDK, connect to Qiscus Server, the server will then
  * return User Data, we'll need this data for further API request
  * @param {object} options - Qiscus SDK Options
  * @return {void}
  */
  init(options) {
    console.info('Initializing Qiscus SDK');
    // Let's initialize the app based on options 
    if(options) this.options = Object.assign({}, this.options, options);
    this.baseURL             = `//${this.options.AppId}.qiscus.com`;

    if(!this.options.AppId) throw new Error('AppId Undefined');

    // Connect to Login or Register API
    this.connectToQiscus().then((response) => this.emit('login-success', response));
  }

  connectToQiscus() {
    var formData = new FormData();
    formData.append('email', this.email);
    formData.append('password', this.key);
    formData.append('username', this.username);
    if(this.avatar_url) formData.append('avatar_url', this.avatar_url);

    return fetch(`${this.baseURL}/api/v2/mobile/login_or_register`, {
      method: 'POST',
      body: formData
    }).then((response) => {
      return response.json();
    });
  }

  chatTarget(email) {
    // check if the room exists
    let TheRoom;
    let self = this;
    self.isLoading = true;
    TheRoom  = _.find(this.rooms, {name: email});
    if(TheRoom) return this.selected = Room;

    // If not exists, let's get or create target room
    return this.roomAdapter.getOrCreateRoom(email)
    .then((response) => {
      TheRoom = new Room(response);
      qiscus.selected = TheRoom;
      self.isLoading = false;
      return this.selected = qiscus.selected;
    })
  }

  /**
   * This method let us get new comments from server
   * If comment count > 0 then we have new message
   */
  sync() {
    this.userAdapter.sync().
    then((comments) => {
      if(comments.length > 0) this.emit('newmessages', comments);
    })
  }

  _addRoom(room) {
    // check 1st if we already have the room
    const theroom = this._getRoom(room.id);
    if(!theroom) this.rooms.push(room);
  }

  _getRoom(room_id) {
    return _.find(this.rooms, {id: room_id});
  }

  _getRoomOfTopic(topic_id) {
    // TODO: This is expensive. We need to refactor
    // it using some kind map of topicId as the key
    // and roomId as its value.
    return _.find(this.rooms, function(room) {
      return _.find(room.topics, function(topic) {
        return topic.id == topic_id;
      });
    })
  }

  selectRoom(room_id) {
    const room = this._getRoom(room_id);
    if(room.topics.length < 1) {
      // this room hasn't been loaded yet, let's load it
      return this.loadTopics(room_id).then((response) => {
        this.selected.room  = room;
        this.selected.topic = room.topics[0];
      });
    } else {
      this.selected.room  = room;
      this.selected.topic = room.topics[0];
      return new Promise((resolve, reject) => resolve(this.selected));
    }
  }

  selectTopic(topic_id) {
    let room = this.selected.room;
    let topic = room.getTopic(topic_id);
    // check if messages has been loaded or not
    if(topic.comments.length < 1) {
      return this.loadComments(topic_id).then((response) => { this.selected.topic = topic });
    }
    this.selected.topic = topic;
    return new Promise((resolve, reject) => resolve(topic));
  }

  loadTopics(room_id) {
    // note: when we load a topic, we also need to load its' message directly

    return this.roomAdapter.loadTopics(room_id).
    then((response) => {

      // let's add this topics to rooms
      const room = this._getRoom(room_id);
      _.map(response.topics, (res) => {
        let topic = new Topic(res);
        room.addTopic(new Topic(topic));
      })

      // now load the first topic messages
      let topic = room.topics[0];
      if(topic.comments.length < 1) {
        return this.loadComments(topic.id);
      } else {
        return new Promise((resolve, reject) => resolve(room.topics));
      }

    })
  }

  loadComments(topic_id, last_comment_id=0) {
    return this.topicAdapter.loadComments(topic_id, last_comment_id)
    .then((response) => {
      this.selected.receiveComments(_.reverse(response));
      // get the topic
      // let room = this._getRoomOfTopic(topic_id);
      // let topic = room.getTopic(topic_id);
      // let comments;
      // // ada dua kondisi, komen sudah di load( ), dan yang belum
      // if(last_comment_id > 0) {
      //   // ini berarti load more, dibalik dulu comment nya, diprepend, bukan dipush
      //   // ambil komen yang lama
      //   comments = topic.comments;
      //   // ambil komen yang baru, balik dulu urutannya, terus convert ke objek komen
      //   let newComment = _.map(_.reverse(response.comments), (cmt) => new Comment(cmt));
      //   comments = newComment.concat(comments);
      //   topic.comments.length = 0;
      // } else {
      //   comments = _.reverse(response.comments);
      // }
      // _.map(comments, (comment) => {
      //   const cmt = (last_comment_id > 0) ? comment : new Comment(comment);
      //   topic.addComment(cmt);
      // });
      console.info('Receiving Comments');
      return new Promise((resolve, reject) => resolve(response));
    }, (error) => {
      console.error('Error loading comments', error);
    });
  }

  submitComment(topicId, commentMessage, uniqueId) {
    var self = this;
    var room = self._getRoomOfTopic(topicId);

    self.pendingCommentId--;
    var pendingCommentId     = self.pendingCommentId;
    // var pendingCommentSender = room.getParticipant(store.get('qcData').email);
    var pendingCommentDate   = new Date();
    var commentData = {
      message: commentMessage,
      username_as: this.username,
      username_real: this.email,
      user_avatar: this.avatar_url,
      // user_avatar: {
      //   avatar: {
      //     url: this.avatar
      //   }
      // },
      id: pendingCommentId
    }
    var pendingComment       = new Comment(commentData);
    // We're gonna use timestamp for uniqueId for now.
    // "bq" stands for "Bonjour Qiscus" by the way.
    if(!uniqueId) {
      uniqueId = "bq" + Date.now()
    }
    // 		var uniqueId = "bq" + Date.now();
    pendingComment.attachUniqueId(uniqueId);
    pendingComment._markAsPending();
    this.receiveComment(pendingComment, uniqueId);
    return this.userAdapter.postComment(topicId, commentMessage, uniqueId)
    .then((res) => {
      // When the posting succeeded, we mark the Comment as sent,
      // so all the interested party can be notified.
      pendingComment._markAsSent();
      _.remove(this.selected.comments, function(cmt){
        return cmt.id == pendingCommentId;
      })
      return new Promise((resolve, reject) => resolve(res));
    }, (err) => {
      pendingComment.markAsFailed();
      return new Promise((resolve, reject) => reject(err));
    });
  }

  receiveComment(comment, uniqueId) {
    //  var room  = this._getRoomOfTopic(topicId);
    //  var topic = room.getTopic(topicId);
    if(uniqueId){
      var commentWtUniqueId = _.find(this.selected.comments, function(cmt){
        return cmt.unique_id == uniqueId;
      });
      //if uniqueId exist and comment id fake exist, it will delete fake comment
      if(commentWtUniqueId && comment.id > 0){
        _.remove(this.selected.comments, function(cmt){
          return uniqueId == cmt.unique_id;
        })
      }
    }

    // Add the comment.
    let Cmt = _.find(this.selected.comments, {id: comment.id});
    if(!Cmt) this.selected.comments.push(comment);
    //  topic.addComment(comment);
    // Update unread count if necessary. That is, if these two
    // conditions are met:
    // 1. The Comment doesn't belong to the currently selected
    //    Topic. Because it doesn't makes sense to have unread
    //    Comments when the User is currently watching the
    //    Topic, does it?
    // 2. The Comment owner is not the current User. Because
    //    it doesn't make for the User to not read what he/she
    //    wrote.
    // if ( topic != this.selected.topic && comment.sender.email != this.email ) {
    //   topic.increaseUnreadCommentsCount();
    // }
    // If the topic is the currently selected Topic, then
    // we should reset the first unread Comment, because
    // it means that the user (most likely) already read
    // all the unread comments in the Topic.
    // if (topic == this.selected.topic) {
    //   topic.resetFirstUnreadComment();
    // }
    //Check if comment is uploadComment
    //It will not update the id --> if it updates the id it'll be the last room
    // if(!comment.isUploadComment){
    //   // Update last Topic ID and the last Comment ID of the Room if the
    //   // Comment is sent.
    //   if (comment.isSent) {
    //     room.setLastTopicAndComment(topicId, comment.id);
    //   }
    // }
    // Finally, let's make sure the Rooms stay sorted.
    //  this.sortRooms();
  };

  sortRooms() {
    this.rooms.sort(function(leftSideRoom, rightSideRoom) {
      return rightSideRoom.lastCommentId - leftSideRoom.lastCommentId;
    });
  }

}

export class Room {
  constructor(room_data){
    this.id                              = room_data.id;
    this.last_comment_id                 = room_data.last_comment_id;
    this.last_comment_message            = room_data.last_comment_message;
    this.last_comment_message_created_at = room_data.last_comment_message_created_at;
    this.last_comment_topic_id           = room_data.last_topic_id;
    this.last_comment_topic_title        = room_data.last_comment_topic_title;
    this.avatar                          = room_data.room_avatar;
    this.name                            = room_data.name;
    this.room_type                       = room_data.room_type;
    this.secret_code                     = room_data.secret_code;
    this.participants                    = room_data.participants;
    this.topics                          = []
    this.comments                        = []
    this.count_notif                     = room_data.count_notif;
    this.isLoaded                        = false;
    this.code_en                         = room_data.code_en;
    this.receiveComments(room_data.comments);
  }

  receiveComments(comments) {
    _.map(comments, (comment) => {
      let Cmt = _.find(this.comments, {id: comment.id});
      if(!Cmt) this.comments.push(new Comment(comment));
    })
  }

  countUnreadComments() {
    if(this.topics.length == 0) {
      // means that this is not loaded yet, just return the notif
      return this.count_notif;
    } else {
      return _.chain(this.topics)
      .map((topic) => topic.comment_unread)
      .reduce((currentCount, topicCount) => { return currentCount + topicCount }, 0)
      .value();
    }
  }

  addTopic(Topic) {
    // Check if we got the topic in the list
    let topic = this.getTopic(Topic.id);
    if( topic ){
      // let's update the topic with new data
      topic = Object.assign({}, topic, Topic);
    } else {
      this.topics.push(Topic);
    }
  }

  getTopic(topic_id) {
    return _.find(this.topics, (topic) => {
      return topic.id == topic_id
    });
  }

  removeTopic(Topic) {
    const index = this.getTopicIndex(Topic.id);
    if(index < 0) return false;
    this.topics.splice(index, 1);
  }

  getParticipant(email) {
    var existingParticipant = _.find(this.participants, { 'email': participantEmail });

    if (existingParticipant) return existingParticipant;
    return null;
  }
}

export class Topic {
  constructor(topic_data) {
    this.id             = topic_data.id;
    this.title          = topic_data.title;
    this.comment_unread = topic_data.comment_unread;
    this.deleted        = topic_data.deleted || false;
    this.unread         = topic_data.unread;
    this.comments       = [];
    this.isLoaded       = false;
  }

  addComment(Comment) {
    // Check if we got the topic in the list
    let comment = this.getComment(Comment.id);
    if( comment ){
      // let's update the topic with new data
      comment = Object.assign({}, comment, Comment);
    } else {
      this.comments.push(Comment);
    }
  }
  getComment(comment_id) {
    return _.find(this.comments, (comment) => {
      return comment.id == comment_id
    });
  }
  markAsRead() {
    this.comment_unread = 0;
  }
  increaseUnreadCommentsCount() {
    this.comment_unread++;
  }
}

/**
* Qiscus Base Comment Class
*/
export class Comment {
  constructor(comment) {
    this.id            = comment.id;
    this.before_id     = comment.comment_before_id;
    this.message       = comment.message;
    this.username_as   = comment.username_as || comment.username;
    this.username_real = comment.username_real || comment.email;
    let theDate        = moment(comment.created_at);
    this.date          = theDate.format('YYYY-MM-DD');
    this.time          = theDate.format('HH:mm A');
    this.unique_id     = comment.unique_id;
    // this.avatar        = comment.user_avatar.avatar.url;
    this.avatar        = comment.user_avatar;
    /* comment status */
    this.isPending = false;
    this.isSent    = false;
    this.isFailed  = false;
    this.attachment = null;
  }
  isAttachment() {
    return ( this.message.substring(0, "[file]".length) == "[file]" );
  }
  isImageAttachment() {
    return ( this.isAttachment() && this.message.match(/\.(jpg|gif|png)/i) != null );
  }
  attachUniqueId(unique_id) {
    this.unique_id = unique_id;
  }
  getAttachmentURI() {
    if(!this.isAttachment()) return;
    const messageLength = this.message.length;
    const beginIndex = "[file]".length;
    const endIndex   = messageLength - "[/file]".length;
    return this.message.substring(beginIndex, endIndex).trim();
  }
  setAttachment(attachment) {
    this.attachment = attachment;
  }
  _markAsPending() {
    this.isPending = true;
  }
  _markAsSent() {
    this.isSent = true;
  }
  _markAsFailed() {
    this.isFailed = true;
  }

}

window.qiscus = null;
export default (function QiscusStoreSingleton() {
  if (!qiscus) qiscus = new qiscusSDK();
  return qiscus;
})();
