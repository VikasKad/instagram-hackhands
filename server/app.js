var express = require('express');
var path = require('path');
var logger = require('morgan');
var bodyParser = require('body-parser');
var request = require('request');
var jwt = require('jwt-simple');
var mongoose = require('mongoose');
var moment = require('moment');
var cors = require('cors');
var bcrypt = require('bcryptjs');

var config = require('./config');

var User = mongoose.model('User', new mongoose.Schema({
  instagramId: { type: String, index: true },
  email: { type: String, unique: true, lowercase: true },
  password: { type: String, select: false },
  username: String,
  fullName: String,
  picture: String,
  accessToken: String
}));

mongoose.connect(config.db);

var app = express();

app.set('port', process.env.PORT || 3000);
app.use(cors());
app.use(logger('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

/*
 |--------------------------------------------------------------------------
 | Login Required Middleware
 |--------------------------------------------------------------------------
 */
function isAuthenticated(req, res, next) {
  if (!req.headers.authorization) {
    res.status(401).send({
      code: 401,
      message: 'You did not provide a JSON Web Token in the Authorization header.'
    });
  }

  var token = req.headers.authorization.split(' ')[1];
  var payload = jwt.decode(token, config.tokenSecret);
  var now = moment().unix();

  if (now > payload.exp) {
    return res.status(401).send({ message: 'Token has expired' });
  }

  User.findById(payload.sub, function(err, user) {
    console.log(err);
    console.log(user);
    console.log('getting id')
    req.user = user;
    next();
  })
}

/*
 |--------------------------------------------------------------------------
 | Generate JSON Web Token
 |--------------------------------------------------------------------------
 */
function createToken(user) {
  var payload = {
    exp: moment().add(14, 'days').unix(),
    iat: moment().unix(),
    sub: user._id
  };

  return jwt.encode(payload, config.tokenSecret);
}

/*
 |--------------------------------------------------------------------------
 | Sign in with Email
 |--------------------------------------------------------------------------
 */
app.post('/auth/login', function(req, res) {
  User.findOne({ email: req.body.email }, '+password', function(err, user) {
    if (!user) {
      return res.status(401).send({ message: { email: 'Incorrect email' } });
    }

    bcrypt.compare(req.body.password, user.password, function(err, isMatch) {
      if (!isMatch) {
        return res.status(401).send({ message: { password: 'Incorrect password' } });
      }

      user = user.toObject();
      delete user.password;

      var token = createToken(user);
      res.send({ token: token, user: user });
    });
  });
});

/*
 |--------------------------------------------------------------------------
 | Create Email and Password Account
 |--------------------------------------------------------------------------
 */
app.post('/auth/signup', function(req, res) {
  User.findOne({ email: req.body.email }, function(err, existingUser) {
    if (existingUser) {
      return res.status(409).send({ message: 'Email is already taken' });
    }

    var user = new User({
      email: req.body.email,
      password: req.body.password
    });

    bcrypt.genSalt(10, function(err, salt) {
      bcrypt.hash(user.password, salt, function(err, hash) {
        user.password = hash;

        user.save(function() {
          var token = createToken(user);
          res.send({ token: token, user: user });
        });
      });
    });
  });
});

/*
 |--------------------------------------------------------------------------
 | Sign in with Instagram
 |--------------------------------------------------------------------------
 */
app.post('/auth/instagram', function(req, res) {
  var accessTokenUrl = 'https://api.instagram.com/oauth/access_token';

  var params = {
    client_id: req.body.clientId,
    redirect_uri: req.body.redirectUri,
    client_secret: config.clientSecret,
    code: req.body.code,
    grant_type: 'authorization_code'
  };

  request.post({ url: accessTokenUrl, form: params, json: true }, function(e, r, body) {

    // Step 3a. Link user accounts.
    if (req.headers.authorization) {

      User.findOne({ instagramId: body.user.id }, function(err, existingUser) {

        var token = req.headers.authorization.split(' ')[1];
        var payload = jwt.decode(token, config.tokenSecret);
        console.log(payload);
        // todo: return error if trying to link instagram account with instagram


        User.findById(payload.sub, '+password', function(err, localUser) {
          if (!localUser) {
            return res.status(400).send({ message: 'User not found' });
          }

          // Merge existing Instagram account with the currently logged-in local account
          if (existingUser) {

            existingUser.email = localUser.email;
            existingUser.password = localUser.password;

            localUser.remove();

            existingUser.save(function() {
              var token = createToken(existingUser);
              return res.send({ token: token, user: existingUser });
            });

          } else {
            // Link current local account with the new instagram account info
            localUser.instagramId = body.user.id;
            localUser.username = body.user.username;
            localUser.fullName = body.user.full_name;
            localUser.picture = body.user.profile_picture;
            localUser.accessToken = body.access_token;

            localUser.save(function() {
              var token = createToken(localUser);
              res.send({ token: token, user: localUser });
            });

          }
        });
      });
    } else {
      // Step 3b. Create a new user account or return an existing one.
      User.findOne({ instagramId: body.user.id }, function(err, existingUser) {
        if (existingUser) {
          var token = createToken(existingUser);
          return res.send({ token: token, user: existingUser });
        }

        var user = new User({
          instagramId: body.user.id,
          username: body.user.username,
          fullName: body.user.full_name,
          picture: body.user.profile_picture,
          accessToken: body.access_token
        });

        user.save(function() {
          var token = createToken(user);
          res.send({ token: token, user: user });
        });
      });
    }
  });
});

app.get('/api/feed', isAuthenticated, function(req, res, next) {
  var feedUrl = 'https://api.instagram.com/v1/users/self/feed';
  var params = { access_token: req.user.accessToken };

  request.get({ url: feedUrl, qs: params, json: true }, function(error, response, body) {
    if (!error && response.statusCode == 200) {
      res.send(body.data);
    }
  });
});

app.get('/api/media/:id', isAuthenticated, function(req, res, next) {
  var mediaUrl = 'https://api.instagram.com/v1/media/' + req.params.id;
  var params = { access_token: req.user.accessToken };

  request.get({ url: mediaUrl, qs: params, json: true }, function(error, response, body) {
    if (!error && response.statusCode == 200) {
      res.send(body.data);
    }
  });
});

app.post('/api/like', isAuthenticated, function(req, res, next) {
  var mediaId = req.body.mediaId;
  var likeUrl = 'https://api.instagram.com/v1/media/' + mediaId + '/likes';

  request.post({ url: likeUrl, form: { access_token: req.user.accessToken }, json: true }, function(error, response, body) {
    if (response.statusCode !== 200) {
      return res.status(response.statusCode).send({
        code: response.statusCode,
        message: body.meta.error_message
      });
    }
    res.status(200).end();
  });
});

app.listen(app.get('port'), function() {
  console.log('Express server listening on port ' + app.get('port'));
});