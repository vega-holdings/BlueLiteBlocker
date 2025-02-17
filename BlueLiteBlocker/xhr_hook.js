(function() {
    console.log("BlueLiteBlocker: loaded ext");

    let blf_settings = {};
    let blf_exception_log = [];

    // add an event listener to receive settings update from extension config
    window.addEventListener("BLFsettingsUpdate", function (event) {
        blf_settings = event.detail;
    });

    function log_exception(e) {
        while (blf_exception_log.length >= 10) {
            blf_exception_log.shift();
        }

        blf_exception_log.push(e);
        console.log('log_exception() got exception: ');
        console.log(e);
    }

    class TwitterUser {
    constructor(id, handle, name, followers, friends_count, verified_type, affiliated, we_follow, followed_by, is_bluecheck, is_blocked) {
        this.id = id;
        this.handle = handle;
        this.name = name;
        this.followers = followers;
        this.friends_count = friends_count;
        this.verified_type = verified_type;
        this.affiliated = affiliated;
        this.we_follow = we_follow;
        this.followed_by = followed_by;
        this.is_bluecheck = is_bluecheck;
        this.is_blocked = is_blocked;
        this.normalized_ratio = null;  // Initialize as null
    }

    calculateNormalizedRatio() {
    console.log(`Calculating ratio for ${this.handle}: followers = ${this.followers}, friends_count = ${this.friends_count}`);
   if (this.friends_count === 0) {
    this.normalized_ratio = 100;
	} else {
		this.normalized_ratio = ((this.followers - this.friends_count) / (this.followers + this.friends_count)) * 100;
	}
	console.log(`Calculated normalized_ratio for ${this.handle}: ${this.normalized_ratio}`);
	}


	}
    // hook XMLHttpRequest.open to filter API responses and remove any blue check tweets
    let old_xml_open = XMLHttpRequest.prototype.open;

    XMLHttpRequest.prototype.open = function () {
		
        if (arguments.length >= 2 && arguments[0] !== "") {

            // hook HomeTimeline API to parse timeline tweets
            if (arguments[1].search('https://twitter.com/i/api/graphql/.*/HomeTimeline') !== -1 ||
                arguments[1].search('https://twitter.com/i/api/graphql/.*/HomeLatestTimeline') !== -1
            ) {
                if (!this._xhr_response_hooked) {
                    this._xhr_response_hooked = true;
                    set_response_hook(this, 'home');
                }
            }

            // hook TweetDetail API to parse tweet replies
            if (arguments[1].search('https://twitter.com/i/api/graphql/.*/TweetDetail') !== -1) {
                if (!this._xhr_response_hooked) {
                    this._xhr_response_hooked = true;
                    set_response_hook(this, 'replies');
                }
            }

            // hook search API to parse search and trending topics
            if (arguments[1].search('https://twitter.com/i/api/2/search/adaptive.json') !== -1) {
                if (!this._xhr_response_hooked) {
                    this._xhr_response_hooked = true;
                    set_response_hook(this, 'search');
                }
            }

            // hook notifications API to parse notification feed
            if (arguments[1].search('https://twitter.com/i/api/2/notifications/all.json') !== -1 ||
                arguments[1].search('https://twitter.com/i/api/2/notifications/mentions.json') !== -1) {
                if (!this._xhr_response_hooked) {
                    this._xhr_response_hooked = true;
                    set_response_hook(this, 'search');
                }
            }
        }
        old_xml_open.apply(this, arguments);
    }

    // overwrite the getter and setter of XMLHttpRequest.responseText to modify responses (surely there's a better way?)
    function set_response_hook(xhr, timeline_type) {
        function getter() {
            delete xhr.responseText;
            let xhr_response = xhr.responseText;

            try {
                let json = JSON.parse(xhr_response);
                parse_timeline(timeline_type, json);
                xhr_response = JSON.stringify(json);
            } catch (e) {
                log_exception(e);
            }

            setup();
            return xhr_response;
        }

        function setter(str) {
            this._var = str;
        }

        function setup() {
            Object.defineProperty(xhr, 'responseText', {
                _var: '',
                get: getter,
                set: setter,
                configurable: true
            });
        }

        setup();
    }

    function hide_tweet(tweet_results, hard_hide, hide_message='Hidden Twitter Tweet') {
        if (tweet_results['result']['__typename'] === 'Tweet') {
            const old_tweet_results = structuredClone(tweet_results['result']);

            // prevent tweets from showing at all, instead of collapsing them
            if (hard_hide) {
                tweet_results['result']['__typename'] = '';
                return;
            }

            delete tweet_results['result'];

            // replace the tweet results with the collapse block casing the client to hide the tweet for us
            tweet_results['result'] = {
                "__typename": "TweetWithVisibilityResults",
                "tweet": old_tweet_results,
                "tweetInterstitial": {
                    "__typename": "ContextualTweetInterstitial",
                    "displayType": "EntireTweet",
                    "text": {
                        "rtl": false,
                        "text": hide_message,
                        "entities": []
                    },
                    "revealText": {
                        "rtl": false,
                        "text": "View",
                        "entities": []
                    }
                }
            }
        }
    }

    function get_tweet_user_info(item_content) {
        // results with type 'Tweet' are normal tweets, 'TweetWithVisibilityResults' are tweets from accounts we blocked
        const allowed_type_names = ['TweetWithVisibilityResults', 'Tweet'];
		
        // only process results with type TimelineTweet (all tweets should have this type)
        if (item_content['itemType'] !== 'TimelineTweet') {
            return false;
        }

        // only process results with correct __typename
        if (!allowed_type_names.includes(item_content['tweet_results']['result']['__typename'])) {
            console.warn(`invalid __typename: ${item_content['itemType']}`)
            return false;
        }

        let tweet_data = item_content['tweet_results']['result'];
        if(blf_settings.hide_promote && key_exists(item_content, 'promotedMetadata')) {
            hide_tweet(item_content['tweet_results'], false, 'Hidden Ad');
        }

        // tweets of type 'TweetWithVisibilityResults' have a slightly different format we need to parse
        if (tweet_data['__typename'] === 'TweetWithVisibilityResults') {
            // the data we need is in a nested field called 'tweet'
            tweet_data = tweet_data['tweet'];
        }

        const user_data = tweet_data['core']['user_results']['result'];
        const legacy_user_data = user_data['legacy'];
		
		
		let affiliated = '';
		let followed_by = safe_get_value(legacy_user_data, 'followed_by', false);
        if (key_exists(user_data, 'affiliates_highlighted_label') &&
            key_exists(user_data['affiliates_highlighted_label'], 'label') &&
            key_exists(user_data['affiliates_highlighted_label']['label'], 'userLabelType')
        ) {
            const label = user_data['affiliates_highlighted_label']['label'];
            affiliated = safe_get_value(label, 'userLabelType', '');
        }

        return new TwitterUser(
            safe_get_value(user_data, 'rest_id', 'undefined'),
            legacy_user_data['screen_name'],
            legacy_user_data['name'],
            legacy_user_data['followers_count'],
			legacy_user_data['friends_count'],  // Add this line
            safe_get_value(legacy_user_data, 'verified_type', ''),
            affiliated,
			followed_by,
            safe_get_value(legacy_user_data, 'following', false),
            user_data['is_blue_verified'],
            safe_get_value(legacy_user_data, 'blocking', false),	
			
        );
    }
	
	function insertRatioIntoTweet(user, tweetElement) {
    // Create an element to hold the ratio
    //const ratioElement = document.createElement('span');
    //ratioElement.innerText = `Normalized Ratio: ${user.normalized_ratio}`;
    //ratioElement.style.color = 'green';
    // Insert the element into the tweet
    //tweetElement.appendChild(ratioElement);
	}


    // check if the user is Twitter Blue and meets the filter criteria
    function is_bad_user(user) {
        /*
        only block Twitter blue users who meet the following criteria:
          - aren't a business account
          - aren't a government account
          - have less than X followers
          - aren't followed by us
        
        let bad_user = user.is_bluecheck
            && user.followers < blf_settings.follow_limit
            && user.we_follow === false
            && user.verified_type === '';

        if (blf_settings.allow_affiliate && user.affiliated !== '')
            bad_user = false;
		*/		
		
		return (user.followers < blf_settings.follow_limit) && !user.we_follow && !user.followed_by;

        return bad_user;
    }

    function handleTweet(entry_type, item_content) {
        const user = get_tweet_user_info(item_content);

        if (is_bad_user(user)) {
            hide_tweet(item_content['tweet_results'], blf_settings.hard_hide);
            console.log(`Tweet filtered from @${user.handle} (Blue User - ${user.followers} followers)`);
            return true;
        }
        return false;
    }

    function parse_search(json) {
        if (!key_exists(json, 'globalObjects') ||
            !key_exists(json['globalObjects'], 'tweets') ||
            !key_exists(json['globalObjects'], 'users')) {
            return;
        }

        const tweets = json['globalObjects']['tweets'];
        const users = json['globalObjects']['users'];

        json['timeline']['instructions'].forEach(instruction => {
            if ('addEntries' in instruction) {
                instruction['addEntries']['entries'].forEach((entry, index) => {
                    if (key_exists(entry['content'], 'item') && key_exists(entry['content']['item'], 'clientEventInfo')) {
                        if (key_exists(entry['content']['item']['content'], 'tweet')) {

                            // the search API is a complete mess, so we have to use index lookups and can't soft-hide tweets
                            const tweet_idx = entry['content']['item']['content']['tweet']['id'];
                            const tweet = tweets[tweet_idx];
                            const user_idx = tweet['user_id_str'];
                            const user_data = users[user_idx];
                            let affiliated = '';

                            if (key_exists(user_data, 'ext') &&
                                key_exists(user_data['ext'], 'highlightedLabel') &&
                                key_exists(user_data['ext']['highlightedLabel'], 'r') &&
                                key_exists(user_data['ext']['highlightedLabel']['r'], 'ok') &&
                                key_exists(user_data['ext']['highlightedLabel']['r']['ok'], 'label')
                            ) {
                                const label = user_data['ext']['highlightedLabel']['r']['ok']['label'];
                                affiliated = safe_get_value(label, 'userLabelType', '');
                            }

                            const user = new TwitterUser(
                                user_data['id_str'],
                                user_data['screen_name'],
                                user_data['name'],
                                user_data['followers_count'],
                                user_data['friends_count'],
                                safe_get_value(user_data, 'ext_verified_type', ''),
                                affiliated,
                                user_data['following'],
                                user_data['ext_is_blue_verified'],
                                user_data['blocking']
                            );
							
                            console.log("User object:", user);
							user.calculateNormalizedRatio();  // Call this after object is fully initialized
							console.log(`Calculated normalized_ratio for ${user.handle}: ${user.normalized_ratio}`);
														


                            if (is_bad_user(user)) {
                                // we can prevent tweets from being displayed by removing 'displayType'
                                //note: due to the way the client works, we can only remove tweets not collapse them.
                                if(key_exists(entry['content']['item']['content'], 'tweet')) {
                                    entry['content']['item']['content']['tweet']['displayType'] = '';
                                }
                                console.log(`Tweet removed from @${user.handle} (User - ${user.followers} followers)`);
                            }
                        }
                    }
                });
            }
        });
    }

    function parse_timeline(timeline_type, json) {
        let instructions = [];

        switch (timeline_type) {
            case 'home':
                instructions = json['data']['home']['home_timeline_urt']['instructions'];
                break;

            case 'replies':
                instructions = json['data']['threaded_conversation_with_injections_v2']['instructions'];
                break;

            case 'search':
                parse_search(json);
                return;

            default:
                console.warn(`parse_timeline got bad type ${timeline_type}`);
                return;

        }

        instructions.forEach(instruction => {
            if (instruction['type'] !== 'TimelineAddEntries')
                return;

            let tweet_entries = instruction['entries'];

            tweet_entries.forEach(entry => {
                switch (entry['content']['entryType']) {
                    // handle regular tweets
                    case 'TimelineTimelineItem':
                        handleTweet(entry['content']['entryType'], entry['content']['itemContent']);
                        break;

                    // handle tweet threads
                    case 'TimelineTimelineModule':
                        let remove_replies = false;
                        let entry_array = entry['content']['items'];

                        //todo: we should probably delete all replies to a Twitter blue user
                        entry_array.forEach((item, index) => {
                            if (remove_replies) {
                                /*
                                    todo: needs testing.
                                    this could break the client if a deleted reply is referenced anywhere else.
                                    afik only feedback boxes reference tweet objects, which shouldn't happen with replies.
                                 */
                                delete entry['content']['items'][index];
                            } else {
                                const blocked_user = handleTweet(entry['content']['entryType'], item['item']['itemContent']);
                                // if hard filtering is enabled we should also hard filter replies to avoid breaking thread
                                if (blocked_user && blf_settings.hard_hide) {
                                    remove_replies = true;
                                }
                            }
                        });
                        break
                }
            });
        });

        return JSON.stringify(json);
    }

    function key_exists(object, key) {
        return typeof object[key] !== 'undefined';
    }

    function safe_get_value(object, key, default_value) {
        if(key_exists(object, key)) {
            return object[key];
        }

        return default_value;
    }

})();
