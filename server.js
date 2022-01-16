const fs = require('fs');
const express = require('express');
require('dotenv').config(); // Load .env into process.env
const { google } = require('googleapis');
const child_process = require('child_process');

const app = express();
app.use(require('express-session')({
  secret: process.env.SESSION_SECRET,
  // TODO: Use `secure` on express-session cookies. Requires 'trust proxy'
  // to be set, because (at the moment) HTTPS requires a reverse proxy for this.
}));
app.use(express.json());

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI,
);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline', // 'offline' allows us to get a refresh token, though at the moment we're not using it
  scope: 'https://www.googleapis.com/auth/youtube.readonly',
});

const indexHTML = fs.readFileSync('index.html', 'utf8')
                    .replace('{{authUrl}}', authUrl);

app.get('/', (_req, res) => {
  res.status(200)
     .send(indexHTML);
});

app.get('/oauth/callback', async (req, res) => {
  const { code } = req.query;
  const { tokens } = await oauth2Client.getToken(code);
  req.session.tokens = tokens;

  res.redirect('/');
});

const fetchPublicYouTubeVideos = async (auth) => {
  const youtube = google.youtube('v3');

  // Fetch some metadata about the current user's channel
  const { data } = await youtube.channels.list({
    auth,
    part: 'contentDetails',
    mine: true,
  });

  // Uploaded videos can be fetched with the "Uploads" playlist
  const uploadsPlaylistId = data.items[0].contentDetails.relatedPlaylists.uploads;

  // Fetch the videos in the uploads playlist, 50 at a time.
  // "snippet" contains the video title and ID, among other things.
  // "status" contains the privacy status of the video.
  // All of this is happening between the fetcher and YT directly,
  // so the extension author cannot see this request or response.
  const videos = [];
  let nextPageToken = null;
  do {
    const response = await youtube.playlistItems.list({
      auth,
      part: 'snippet,status',
      playlistId: uploadsPlaylistId,
      maxResults: 50,
      pageToken: nextPageToken,
    });
    videos.push(...response.data.items);
    nextPageToken = response.data.nextPageToken;
  } while (nextPageToken);

  // This is why we fetched the privacy status
  const publicVideos = videos.filter(video => video.status.privacyStatus === 'public');

  // Now we grab just what we need from the snippet
  const videoObjects = publicVideos.map(object => ({
    title: object.snippet.title,
    videoId: object.snippet.resourceId.videoId,
  }));

  return videoObjects;
};

app.get('/api/get-public-videos', async (req, res) => {
  if (!req.session.tokens) {
    return res.status(401)
              .json({ error: 'Not logged in' });
  }

  const { tokens } = req.session;
  // TODO: what if oauth2Client is reused?
  oauth2Client.setCredentials(tokens);

  // This loads all videos during user interactivity. Ideally,
  // we may want to do this all in a job after the user is gone, but
  // for now, we want to show the user which videos are being processed.
  const publicVideos = await fetchPublicYouTubeVideos(oauth2Client);

  // TODO: Store fetch timestamp so we can display this and
  // reload if the user comes back later.
  req.session.publicVideos = publicVideos;

  res.status(200).json({ publicVideos });
});

app.post('/api/fetch-dislikes', async (req, res) => {
  // Fail early if there's no token
  if (!req.session.tokens) {
    return res.status(401)
    .json({ error: 'Not logged in' });
  }
  
  // Fail early if the video IDs are wrong
  const { videoIds } = req.body;
  if (!Array.isArray(videoIds)
        || videoIds.length === 0
        || videoIds.some(id => !id.match(/^[A-Za-z0-9_\-]{11}$/))
        || videoIds.length > 50) { // (TODO on the > 50. Later, we'll chunk them)
    return res.status(400)
    .json({ error: 'Invalid video IDs' });
  }
  
  // Make a temporary file in the script directory to store the SSL keys
  // TODO: make this random so it doesn't conflict with other requests
  const sslKeyFile = `${__dirname}/ssllog.log`;
  
  // We make this request with cURL for a few reasons:
  // - it lets us use a proxy pretty easily
  // - since this is the critical request (the one being made through the proxy),
  //   it should be pretty transparent what's happening. cURL helps with that
  // - it has a config option to output SSL keys, which we need

  const requestUrl = new URL('https://youtubeanalytics.googleapis.com/v2/reports');
  requestUrl.searchParams.set('dimensions', 'video');
  requestUrl.searchParams.set('startDate', '1970-01-01');
  requestUrl.searchParams.set('endDate', '2050-01-01'); // remind me
  requestUrl.searchParams.set('metrics', 'dislikes');
  requestUrl.searchParams.set('ids', 'channel==mine');
  requestUrl.searchParams.set('filters', `video==${videoIds.join(',')}`);

  const stdout = await new Promise((resolve, reject) => {
    child_process.execFile('curl', [
      // The proxy expects HTTP/1.1 and TLS 1.3
      '--http1.1',
      
      '--tlsv1.3',
      
      '--tls-max',
      '1.3',

      // Use the configured proxy
      '--proxy',
      process.env.PROXY_URL,

      // Authenticate with the stored token
      '--header',
      'Authorization: Bearer ' + req.session.tokens.access_token,
      
      '--header',
      'Accept: application/json',
      
      '--header',
      'Content-Type: application/json',

      // This is the URL for the API request
      requestUrl.toString(),
    ], {
      env: {
        SSLKEYLOGFILE: sslKeyFile,
      },
    }, (err, stdout, stderr) => {
      if (err) {
        reject(err);
      } else {
        resolve(stdout);
      }
    });
  });

  const obj = JSON.parse(stdout);
  console.log(obj);
});

app.listen(parseInt(process.argv[2], 10), () => {
  console.log('listening');
});